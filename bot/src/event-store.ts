import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Каталог данных вычисляем лениво: тесты подменяют его через EVENT_DATA_DIR,
// а в проде это /opt/bot/bot — рядом с user-chat-ids.json.
function dataDir(): string {
  return process.env.EVENT_DATA_DIR || path.join(__dirname, '..')
}

export function registrationsFile(): string {
  return path.join(dataDir(), 'event-registrations.json')
}

export function draftsFile(): string {
  return path.join(dataDir(), 'event-drafts.json')
}

// ─── Типы ────────────────────────────────────────────────────────────────

export type EventRegistration = {
  chatId: number
  name: string          // имя и фамилия одной строкой, как прислал человек
  username: string      // без @, пустая строка если ника нет
  visitDate: string     // YYYY-MM-DD
  registeredAt: string  // ISO
  /** выгружена ли строка в Google Sheets. Смена даты сбрасывает флаг */
  synced: boolean
}

export type EventMode = 'on' | 'off'

type EventState = {
  version: 1
  mode: EventMode
  capacity: number
  registrations: EventRegistration[]
}

export type DraftStep = 'name' | 'date'

export type EventDraft = {
  chatId: number
  step: DraftStep
  name?: string
  /** edit — человек меняет дату уже существующей записи, шаг имени пропускается */
  kind: 'new' | 'edit'
  updatedAt: number
}

export const DEFAULT_CAPACITY = Number(process.env.EVENT_CAPACITY ?? 400)
const DEFAULT_MODE: EventMode = (process.env.EVENT_MODE === 'off' ? 'off' : 'on')

/** Брошенные черновики старше суток удаляем — человек давно ушёл */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

// ─── Состояние в памяти ──────────────────────────────────────────────────

const registrations = new Map<number, EventRegistration>()
const drafts = new Map<number, EventDraft>()
let mode: EventMode = DEFAULT_MODE
let capacity = DEFAULT_CAPACITY

// ─── Запись файлов ───────────────────────────────────────────────────────

/**
 * Атомарная запись: пишем во временный файл и переименовываем.
 * Прямой writeFileSync поверх existing при падении процесса/диске оставляет
 * обрезанный JSON — а это единственная копия списка гостей.
 */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

function serializeState(): string {
  const state: EventState = {
    version: 1,
    mode,
    capacity,
    registrations: Array.from(registrations.values()),
  }
  return JSON.stringify(state, null, 2)
}

/**
 * Синхронная запись — БЕЗ debounce, в отличие от user-store.
 * Регистрация, потерянная при рестарте PM2, — это не пришедший на мероприятие
 * человек, которому бот сказал «готово». Цена fsync здесь несопоставимо ниже.
 */
function saveState(): void {
  writeAtomic(registrationsFile(), serializeState())
}

/**
 * Возвращает путь, куда отложен повреждённый файл, если такое случилось —
 * вызывающий обязан на это громко пожаловаться.
 */
export function loadEventState(): { corruptedBackup?: string } {
  registrations.clear()
  const file = registrationsFile()

  if (!fs.existsSync(file)) {
    console.log('[event-store] файл регистраций не найден — начинаем с пустого списка')
    return {}
  }

  let parsed: Partial<EventState>
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EventState>
  } catch (error: any) {
    // Файл нечитаем. Ронять процесс нельзя — бот обслуживает заказы и треки,
    // рестарт-луп остановил бы магазин целиком. Но и писать поверх нельзя:
    // первая же регистрация затрёт список гостей. Отодвигаем файл в сторону,
    // стартуем с чистого и громко зовём людей — данные при этом целы и на
    // диске, и (почти всегда) уже выгружены в Google Sheets.
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      fs.renameSync(file, backup)
    } catch (renameError: any) {
      console.error('[event-store] повреждённый файл не удалось отодвинуть:', renameError?.message)
      throw new Error(`event-registrations.json повреждён и не переименовывается: ${renameError?.message}`)
    }
    console.error(`[event-store] файл регистраций повреждён (${error?.message}), отложен в ${backup}`)
    return { corruptedBackup: backup }
  }

  if (parsed && typeof parsed === 'object') {
    if (parsed.mode === 'on' || parsed.mode === 'off') mode = parsed.mode
    if (typeof parsed.capacity === 'number' && parsed.capacity > 0) capacity = parsed.capacity
    for (const r of parsed.registrations ?? []) {
      if (r && typeof r.chatId === 'number') {
        registrations.set(r.chatId, { ...r, synced: r.synced === true })
      }
    }
  }
  console.log(`[event-store] загружено ${registrations.size} регистраций, режим=${mode}, лимит=${capacity}`)
  return {}
}

// ─── Черновики формы ─────────────────────────────────────────────────────
// Переживают рестарт PM2: во время анонса рестарт по watchdog'у иначе бросил бы
// всех, кто в этот момент заполнял форму, без единого сообщения.

export const DRAFT_SAVE_DEBOUNCE_MS = Number(process.env.SAVE_DEBOUNCE_MS ?? 2000)
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null

/** Пишет черновики немедленно. Отдельно от таймера — нужен при остановке процесса. */
export function flushDrafts(): void {
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null }
  try {
    writeAtomic(draftsFile(), JSON.stringify(Array.from(drafts.values()), null, 2))
  } catch (error: any) {
    console.warn('[event-store] не удалось сохранить черновики:', error?.message)
  }
}

function scheduleDraftSave(): void {
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(flushDrafts, DRAFT_SAVE_DEBOUNCE_MS)
}

export function loadEventDrafts(): void {
  drafts.clear()
  try {
    const file = draftsFile()
    if (!fs.existsSync(file)) return
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return
    const cutoff = Date.now() - DRAFT_TTL_MS
    for (const d of parsed) {
      if (d && typeof d.chatId === 'number' && d.updatedAt > cutoff) drafts.set(d.chatId, d)
    }
    console.log(`[event-store] загружено ${drafts.size} черновиков формы`)
  } catch (error: any) {
    // черновик — не данные гостя, его потеря переживаема: человек начнёт заново
    console.warn('[event-store] черновики не прочитались:', error?.message)
  }
}

export function getDraft(chatId: number): EventDraft | undefined {
  const draft = drafts.get(chatId)
  if (!draft) return undefined
  if (Date.now() - draft.updatedAt > DRAFT_TTL_MS) {
    drafts.delete(chatId)
    scheduleDraftSave()
    return undefined
  }
  return draft
}

export function setDraft(draft: Omit<EventDraft, 'updatedAt'>): EventDraft {
  const saved: EventDraft = { ...draft, updatedAt: Date.now() }
  drafts.set(draft.chatId, saved)
  scheduleDraftSave()
  return saved
}

export function deleteDraft(chatId: number): void {
  if (drafts.delete(chatId)) scheduleDraftSave()
}

export function draftCount(): number {
  return drafts.size
}

// ─── Регистрации ─────────────────────────────────────────────────────────

export function getRegistration(chatId: number): EventRegistration | undefined {
  return registrations.get(chatId)
}

export function registrationCount(): number {
  return registrations.size
}

export function getCapacity(): number {
  return capacity
}

export function isFull(): boolean {
  return registrations.size >= capacity
}

export function getMode(): EventMode {
  return mode
}

export function setMode(next: EventMode): void {
  mode = next
  saveState()
}

export function setCapacity(next: number): void {
  capacity = next
  saveState()
}

/**
 * Записывает гостя. Бросает исключение, если файл не сохранился — вызывающий
 * ОБЯЗАН поймать и сказать человеку правду, а не «готово».
 * Память откатываем, чтобы счётчик не разошёлся с файлом.
 */
export function addRegistration(entry: Omit<EventRegistration, 'synced'>): void {
  const previous = registrations.get(entry.chatId)
  registrations.set(entry.chatId, { ...entry, synced: false })
  try {
    saveState()
  } catch (error) {
    if (previous) registrations.set(entry.chatId, previous)
    else registrations.delete(entry.chatId)
    throw error
  }
}

/** Смена даты визита. Сбрасывает synced — флашер перезальёт строку в таблицу. */
export function updateVisitDate(chatId: number, visitDate: string): boolean {
  const existing = registrations.get(chatId)
  if (!existing) return false
  if (existing.visitDate === visitDate) return true
  const previous = { ...existing }
  registrations.set(chatId, { ...existing, visitDate, synced: false })
  try {
    saveState()
  } catch (error) {
    registrations.set(chatId, previous)
    throw error
  }
  return true
}

// ─── Выгрузка в Google Sheets ────────────────────────────────────────────

export function listUnsynced(limit = 500): EventRegistration[] {
  const out: EventRegistration[] = []
  for (const r of registrations.values()) {
    if (!r.synced) out.push(r)
    if (out.length >= limit) break
  }
  return out
}

export function unsyncedCount(): number {
  let n = 0
  for (const r of registrations.values()) if (!r.synced) n++
  return n
}

/** Возраст самой старой невыгруженной записи в мс (0, если всё выгружено) */
export function oldestUnsyncedAgeMs(): number {
  let oldest = 0
  const now = Date.now()
  for (const r of registrations.values()) {
    if (r.synced) continue
    const age = now - new Date(r.registeredAt).getTime()
    if (Number.isFinite(age) && age > oldest) oldest = age
  }
  return oldest
}

/**
 * Помечает выгруженными. Записи, изменившиеся во время сетевого запроса
 * (человек сменил дату), не трогаем — сверяем visitDate.
 */
export function markSynced(entries: EventRegistration[]): void {
  let changed = false
  for (const sent of entries) {
    const current = registrations.get(sent.chatId)
    if (!current || current.synced) continue
    if (current.visitDate !== sent.visitDate) continue
    registrations.set(sent.chatId, { ...current, synced: true })
    changed = true
  }
  if (!changed) return
  try {
    saveState()
  } catch (error: any) {
    // Данные гостей на месте, потеряется лишь отметка о выгрузке — в худшем
    // случае строки уйдут в таблицу повторно, там дедуп по chat_id.
    console.warn('[event-store] не удалось сохранить отметки о выгрузке:', error?.message)
  }
}

// ─── Экспорт для менеджера ───────────────────────────────────────────────

export function listRegistrations(): EventRegistration[] {
  return Array.from(registrations.values())
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))
}

/** Разбивка по датам визита: '2026-09-23' → сколько человек */
export function countByDate(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const r of registrations.values()) {
    counts.set(r.visitDate, (counts.get(r.visitDate) ?? 0) + 1)
  }
  return counts
}

export function countRegisteredSince(sinceMs: number): number {
  let n = 0
  for (const r of registrations.values()) {
    const t = new Date(r.registeredAt).getTime()
    if (Number.isFinite(t) && t >= sinceMs) n++
  }
  return n
}

function csvCell(value: string): string {
  // Разделитель — точка с запятой (русский Excel), поэтому экранируем и её.
  // Ведущие =+-@ обезвреживаем апострофом: иначе имя вроде "=cmd" Excel
  // попытается исполнить как формулу.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/**
 * Собачку приклеиваем ПОСЛЕ экранирования: ник состоит только из [A-Za-z0-9_],
 * то есть безопасен, и защита от формул на нём срабатывать не должна — иначе
 * менеджер видит в каждой строке «'@anya» вместо «@anya».
 */
function csvUsername(username: string): string {
  return username ? `@${csvCell(username)}` : ''
}

/** CSV для выгрузки менеджеру. BOM обязателен — без него Excel ломает кириллицу. */
export function buildCsv(): string {
  const header = ['name', 'username', 'chat_id', 'visit_date', 'registered_at', 'synced']
  const lines = [header.join(';')]
  for (const r of listRegistrations()) {
    lines.push([
      csvCell(r.name),
      csvUsername(r.username),
      csvCell(String(r.chatId)),
      csvCell(r.visitDate),
      csvCell(r.registeredAt),
      csvCell(r.synced ? 'да' : 'нет'),
    ].join(';'))
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

/** Только для тестов: сбрасывает состояние модуля */
export function __resetForTests(): void {
  registrations.clear()
  drafts.clear()
  mode = DEFAULT_MODE
  capacity = DEFAULT_CAPACITY
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null }
}
