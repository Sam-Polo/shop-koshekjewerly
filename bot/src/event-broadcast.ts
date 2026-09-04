import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendAlert } from './alerts.js'
import { sendOfferPost } from './event.js'
import { getRegistration } from './event-store.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function broadcastFile(): string {
  const dir = process.env.EVENT_DATA_DIR || path.join(__dirname, '..')
  return path.join(dir, 'event-broadcast.json')
}

/**
 * Рассылка приглашения на шоурум.
 *
 * Почему не подходит обычный /broadcast:
 * 1. он умеет только кнопку web_app/url, а приглашению нужна callback-кнопка
 *    «Зарегистрироваться» — она запускает форму внутри бота;
 * 2. он шлёт всем подряд, включая уже записавшихся;
 * 3. он ждёт отправки ВНУТРИ хэндлера. Для 16 тысяч получателей это ~16 минут,
 *    в течение которых grammY (последовательный!) не обрабатывает апдейты —
 *    то есть никто не может нажать ту самую кнопку регистрации, ради которой
 *    рассылку и затевали. Здесь цикл отвязан от хэндлера и крутится параллельно
 *    с обработкой апдейтов.
 */

type BroadcastState = {
  version: 1
  /** кому приглашение уже уходило — защита от повторного залпа по всей базе */
  notified: number[]
  startedAt?: string
  finishedAt?: string
  lastStats?: BroadcastStats
}

export type BroadcastStats = {
  sent: number
  /** заблокировали бота или чат недоступен — ожидаемая часть любой рассылки */
  blocked: number
  /** прочие ошибки отправки */
  failed: number
}

const notified = new Set<number>()
let state: BroadcastState = { version: 1, notified: [] }

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, file)
}

function save(): void {
  state.notified = Array.from(notified)
  writeAtomic(broadcastFile(), JSON.stringify(state))
}

export function loadBroadcastState(): void {
  notified.clear()
  state = { version: 1, notified: [] }
  try {
    const file = broadcastFile()
    if (!fs.existsSync(file)) return
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BroadcastState>
    if (!parsed || typeof parsed !== 'object') return
    for (const id of parsed.notified ?? []) {
      if (typeof id === 'number') notified.add(id)
    }
    state = { version: 1, notified: Array.from(notified), startedAt: parsed.startedAt, finishedAt: parsed.finishedAt, lastStats: parsed.lastStats }
    console.log(`[event-broadcast] загружено ${notified.size} уже оповещённых`)
  } catch (error: any) {
    // Потеря этого файла не трогает данные гостей — она лишь означает, что
    // повтор рассылки заденет тех, кто её уже получал. Поэтому ничего не роняем,
    // но и молчать не будем: менеджер должен знать, почему возможен дубль.
    console.warn('[event-broadcast] состояние рассылки не прочиталось:', error?.message)
    sendAlert(`Состояние рассылки приглашений не прочиталось: ${error?.message}`, {
      tag: 'event-broadcast',
      level: 'moderate',
      hint: 'повторный /event_broadcast может отправить приглашение тем, кто его уже получил',
      code: 'EVENT_BROADCAST_STATE_UNREADABLE',
    }).catch(() => {})
  }
}

export function notifiedCount(): number {
  return notified.size
}

export function wasNotified(chatId: number): boolean {
  return notified.has(chatId)
}

// ─── Прогон рассылки ─────────────────────────────────────────────────────

/** Пауза между отправками. 60мс ≈ 16 сообщений/с — с запасом под лимит
 *  Telegram (~30/с) и место для ответов тем, кто уже жмёт «Зарегистрироваться». */
const PACE_MS = Number(process.env.EVENT_BROADCAST_PACE_MS ?? 60)
/** Как часто сбрасывать прогресс на диск: рестарт не должен повторять залп */
const SAVE_EVERY = 100
/** Как часто докладывать менеджеру, что рассылка жива */
const REPORT_EVERY = Number(process.env.EVENT_BROADCAST_REPORT_EVERY ?? 1000)

export type BroadcastProgress = BroadcastStats & {
  total: number
  processed: number
  startedAt: number
}

let progress: BroadcastProgress | null = null
let stopRequested = false

export function isBroadcastRunning(): boolean {
  return progress !== null
}

export function currentProgress(): BroadcastProgress | null {
  return progress ? { ...progress } : null
}

/** Просит цикл остановиться после текущего получателя */
export function requestBroadcastStop(): boolean {
  if (!progress) return false
  stopRequested = true
  return true
}

/**
 * Кому уходит приглашение: все известные пользователи, кроме уже записавшихся
 * и уже получавших этот пост.
 */
export function selectTargets(allUsers: Iterable<string | number>): {
  targets: number[]
  registered: number
  alreadyNotified: number
} {
  const targets: number[] = []
  let registered = 0
  let alreadyNotified = 0

  for (const raw of allUsers) {
    const chatId = Number(raw)
    if (!Number.isInteger(chatId) || chatId <= 0) continue
    if (getRegistration(chatId)) { registered++; continue }
    if (notified.has(chatId)) { alreadyNotified++; continue }
    targets.push(chatId)
  }

  return { targets, registered, alreadyNotified }
}

function classifyError(e: any): 'blocked' | 'failed' {
  const description: string = e?.description ?? e?.message ?? ''
  const code: number | undefined = e?.error_code
  if (code === 403) return 'blocked'
  if (code === 400 && /chat not found|user is deactivated/i.test(description)) return 'blocked'
  if (/blocked|deactivated|kicked|chat not found/i.test(description)) return 'blocked'
  return 'failed'
}

/**
 * Запускает рассылку ОТВЯЗАННО от хэндлера: функция возвращает управление
 * сразу, цикл живёт сам. Иначе бот на всё время рассылки перестал бы
 * обрабатывать нажатия кнопки регистрации (см. комментарий вверху файла).
 */
export function startBroadcastDetached(
  api: any,
  targets: number[],
  reportTo: number,
): void {
  if (progress) return
  progress = { total: targets.length, processed: 0, sent: 0, blocked: 0, failed: 0, startedAt: Date.now() }
  stopRequested = false
  state.startedAt = new Date().toISOString()
  state.finishedAt = undefined

  void runLoop(api, targets, reportTo).catch((error: any) => {
    // Цикл отвязан от хэндлера, значит bot.catch его не поймает —
    // без своего catch падение стало бы unhandledRejection и тишиной.
    console.error('[event-broadcast] цикл упал:', error?.message)
    sendAlert(`Рассылка приглашений упала: ${error?.message}`, {
      tag: 'event-broadcast',
      level: 'high',
      hint: 'часть получателей осталась без приглашения — повторный /event_broadcast дошлёт только их',
      code: 'EVENT_BROADCAST_FATAL',
    }).catch(() => {})
    progress = null
    try { save() } catch { /* уже залогировано */ }
    api.sendMessage(reportTo, `❌ Рассылка прервана ошибкой: ${error?.message}\nПовторный /event_broadcast дошлёт оставшихся.`).catch(() => {})
  })
}

async function runLoop(api: any, targets: number[], reportTo: number): Promise<void> {
  const p = progress!
  console.log(`[event-broadcast] старт: ${targets.length} получателей, пауза ${PACE_MS}мс`)

  for (const chatId of targets) {
    if (stopRequested) {
      console.log('[event-broadcast] остановлено менеджером')
      break
    }

    try {
      await sendOfferPost(api, chatId)
      p.sent++
      notified.add(chatId)
    } catch (e: any) {
      if (classifyError(e) === 'blocked') {
        p.blocked++
        // человек заблокировал бота — повторять ему бессмысленно
        notified.add(chatId)
      } else {
        p.failed++
        console.warn(`[event-broadcast] ${chatId}: ${e?.description ?? e?.message}`)
      }
    }

    p.processed++

    if (p.processed % SAVE_EVERY === 0) {
      try { save() } catch (e: any) { console.warn('[event-broadcast] прогресс не сохранился:', e?.message) }
    }
    if (p.processed % REPORT_EVERY === 0) {
      const pct = Math.round((p.processed / p.total) * 100)
      api.sendMessage(reportTo, `📤 Рассылка: ${p.processed} из ${p.total} (${pct}%)\nДоставлено ${p.sent}, заблокировали ${p.blocked}, ошибок ${p.failed}`).catch(() => {})
    }

    await new Promise(resolve => setTimeout(resolve, PACE_MS))
  }

  const stats: BroadcastStats = { sent: p.sent, blocked: p.blocked, failed: p.failed }
  const wasStopped = stopRequested
  const minutes = Math.round((Date.now() - p.startedAt) / 60_000)
  const leftover = p.total - p.processed

  state.finishedAt = new Date().toISOString()
  state.lastStats = stats
  progress = null
  stopRequested = false
  try { save() } catch (e: any) { console.warn('[event-broadcast] финальное сохранение не удалось:', e?.message) }

  console.log(`[event-broadcast] готово: отправлено ${stats.sent}, заблокировали ${stats.blocked}, ошибок ${stats.failed}`)

  await api.sendMessage(reportTo,
    `${wasStopped ? '⏹ Рассылка остановлена' : '✅ Рассылка завершена'} за ~${minutes} мин\n\n` +
    `Доставлено: ${stats.sent}\n` +
    `Заблокировали бота: ${stats.blocked}\n` +
    `Ошибок: ${stats.failed}` +
    (leftover > 0 ? `\nНе отправлено: ${leftover} — повторный /event_broadcast дошлёт их` : '')
  ).catch(() => {})

  // Ошибки сверх ожидаемых блокировок — повод посмотреть логи
  if (stats.failed > 0 && stats.failed > stats.sent / 10) {
    sendAlert(
      `Рассылка приглашений: ${stats.failed} ошибок при ${stats.sent} доставленных`,
      {
        tag: 'event-broadcast',
        level: 'moderate',
        hint: 'больше 10% получателей не получили приглашение по причинам, не связанным с блокировкой бота',
        code: 'EVENT_BROADCAST_HIGH_FAILURE_RATE',
      }
    ).catch(() => {})
  }
}

/** Только для тестов */
export function __resetBroadcastForTests(): void {
  notified.clear()
  state = { version: 1, notified: [] }
  progress = null
  stopRequested = false
}
