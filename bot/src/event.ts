import { InlineKeyboard, InputFile } from 'grammy'
import path from 'path'
import { fileURLToPath } from 'url'
import { sendAlert } from './alerts.js'
import {
  addRegistration,
  buildCsv,
  countByDate,
  countRegisteredSince,
  deleteDraft,
  getCapacity,
  getDraft,
  getMode,
  getRegistration,
  isFull,
  listUnsynced,
  markSynced,
  oldestUnsyncedAgeMs,
  registrationCount,
  setDraft,
  unsyncedCount,
  updateVisitDate,
  listRegistrations,
  draftCount,
  type EventRegistration,
} from './event-store.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const BACKEND_URL = process.env.BACKEND_URL || 'https://shop-koshekjewerly.onrender.com'
const WEBAPP_URL = process.env.TG_WEBAPP_URL || 'https://sam-polo.github.io/shop-koshekjewerly/'
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || ''

const BANNER_PATH = path.join(__dirname, '..', 'assets', 'showroom-banner.png')

// ─── Даты мероприятия ────────────────────────────────────────────────────
// Порядок задаёт и порядок кнопок. Метки с днём недели — чтобы человек не
// сверялся с календарём в другом приложении и не терял на этом воронку.

export const EVENT_DAYS: Array<{ date: string; button: string; human: string }> = [
  { date: '2026-09-23', button: '23 сентября · ср', human: '23 сентября (среда)' },
  { date: '2026-09-24', button: '24 сентября · чт', human: '24 сентября (четверг)' },
  { date: '2026-09-25', button: '25 сентября · пт', human: '25 сентября (пятница)' },
  { date: '2026-09-26', button: '26 сентября · сб', human: '26 сентября (суббота)' },
  { date: '2026-09-27', button: '27 сентября · вс', human: '27 сентября (воскресенье)' },
]

function humanDate(date: string): string {
  return EVENT_DAYS.find(d => d.date === date)?.human ?? date
}

// ─── Тексты ──────────────────────────────────────────────────────────────

export const OFFER_TEXT =
  'КОШКИ, мы открываем двери своего временного шоурума в самом сердце Москвы, на Патриарших прудах\n' +
  '\n' +
  '🐆 <b>С 23 по 27 сентября мы будем ждать именно тебя в гости в наш кошачий шоурум</b> 🐆\n' +
  '\n' +
  'Время работы:\n' +
  '23.09 - 26.09 с 11:00 до 21:00\n' +
  '27.09 с 11:00 до 17:00\n' +
  '\n' +
  '🎈<b>Что за движ планируется ?</b>\n' +
  '\n' +
  '▫️ примерка всех наших хитов\n' +
  '▪️ эксклюзивный дроп украшений, которых нет в продаже онлайн\n' +
  '▫️ <b>KOSHEK MADE BAR</b>: возможность собрать персонализированное украшение прям на месте\n' +
  '▪️ при покупке каждая кошечка крутит КОЛЕСО ФОРТУНЫ с щедрыми подарками\n' +
  '\n' +
  '🩷 <b>РЕГИСТРАЦИЯ ОБЯЗАТЕЛЬНА</b>\n' +
  'Зачем ?\n' +
  '\n' +
  'Вход свободный, но для зарегистрированных кошек мы готовим сюрприз при посещении\n' +
  '\n' +
  'ДО ВСТРЕЧИ!🐆'

export const PLACE_TEXT =
  '<b>МЕСТО ВСТРЕЧИ KOSHEK</b>\n' +
  'г. Москва, Патриаршие пруды,\n' +
  'Богословский пер., 16/6, стр. 1\n' +
  '(вход с Большого Палашёвского)\n' +
  '\n' +
  'Накануне отправим тебе напоминание, мяу'

const FULL_TEXT =
  '🐆 Регистрация закрыта — мы набрали максимум гостей.\n' +
  '\n' +
  'Но вход свободный: приходи с 23 по 27 сентября, будем рады!\n' +
  'Адрес: Богословский пер., 16/6, стр. 1 (вход с Большого Палашёвского)'

const ASK_NAME_TEXT =
  'Отлично! 🐆\n' +
  '\n' +
  'Как тебя зовут? Напиши имя и фамилию одним сообщением.\n' +
  '\n' +
  '<i>Отправляя имя, ты соглашаешься на обработку персональных данных.</i>'

const ASK_DATE_TEXT = 'Когда ждать тебя в гости? Выбери день 👇'

const SAVE_FAILED_TEXT =
  '⚠️ Не получилось сохранить регистрацию — это наша техническая ошибка, мы уже о ней знаем.\n' +
  '\n' +
  (SUPPORT_USERNAME
    ? `Напиши, пожалуйста, @${SUPPORT_USERNAME.replace('@', '')} — тебя запишут вручную.`
    : 'Попробуй, пожалуйста, ещё раз через пару минут.')

export const SHOWROOM_BUTTON_TEXT = 'Koshek Show Room 🐆'

// ─── Клавиатуры ──────────────────────────────────────────────────────────

export const CB = {
  offer: 'evt:offer',
  register: 'evt:reg',
  cancel: 'evt:cancel',
  editDate: 'evt:edit',
  day: (date: string) => `evt:day:${date}`,
} as const

function offerKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('Зарегистрироваться 🐆', CB.register)
}

function daysKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard()
  for (const day of EVENT_DAYS) kb.text(day.button, CB.day(day.date)).row()
  return kb
}

function doneKeyboard(): InlineKeyboard {
  return new InlineKeyboard().webApp('KOSHEK JEWERLY🐾', WEBAPP_URL)
}

function registeredKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Изменить дату 📅', CB.editDate).row()
    .webApp('KOSHEK JEWERLY🐾', WEBAPP_URL)
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Баннер: кэш file_id ─────────────────────────────────────────────────
// Первая отправка загружает файл с VDS в Telegram, дальше переиспользуем
// file_id. При анонсе это разница между 400 загрузками картинки и одной.

let bannerFileId: string | null = null
let bannerMissingAlerted = false

function cacheBannerFileId(msg: any): void {
  const photos = msg?.photo
  if (Array.isArray(photos) && photos.length > 0) {
    bannerFileId = photos[photos.length - 1].file_id
    console.log('[event] file_id баннера закэширован')
  }
}

function offerPostOptions() {
  return { caption: OFFER_TEXT, parse_mode: 'HTML' as const, reply_markup: offerKeyboard() }
}

/**
 * Тот же пост-приглашение, но в произвольный чат — для рассылки.
 * Ошибку НЕ глотает: рассылка сама считает недоставленных и разбирает причину.
 * Кэш file_id общий с `/start`, поэтому картинка грузится с VDS один раз
 * на весь прогон, а не 16 тысяч раз.
 */
export async function sendOfferPost(api: any, chatId: number): Promise<void> {
  if (bannerFileId) {
    await api.sendPhoto(chatId, bannerFileId, offerPostOptions())
    return
  }
  const msg = await api.sendPhoto(chatId, new InputFile(BANNER_PATH), offerPostOptions())
  cacheBannerFileId(msg)
}

async function sendOfferMessage(ctx: any): Promise<void> {
  const opts = offerPostOptions()

  if (bannerFileId) {
    try {
      await ctx.replyWithPhoto(bannerFileId, opts)
      return
    } catch (e: any) {
      // file_id мог протухнуть (редко, но бывает) — сбрасываем и грузим заново
      console.warn('[event] баннер по file_id не отправился, перезагружаю:', e?.message)
      bannerFileId = null
    }
  }

  try {
    cacheBannerFileId(await ctx.replyWithPhoto(new InputFile(BANNER_PATH), opts))
  } catch (e: any) {
    // Картинки нет или Telegram её не принял — человек всё равно должен
    // увидеть приглашение и кнопку, но молчать об этом нельзя.
    console.error('[event] не удалось отправить баннер:', e?.message)
    if (!bannerMissingAlerted) {
      bannerMissingAlerted = true
      sendAlert(`Баннер шоурума не отправляется: ${e?.message}`, {
        tag: 'event',
        level: 'high',
        hint: `проверьте файл ${BANNER_PATH} на VDS — приглашение уходит без картинки`,
        code: 'EVENT_BANNER_FAILED',
      }).catch(() => {})
    }
    await ctx.reply(OFFER_TEXT, { parse_mode: 'HTML', reply_markup: offerKeyboard() })
  }
}

/** Приглашение на мероприятие: баннер + текст + кнопка регистрации */
export async function showOffer(ctx: any): Promise<void> {
  const chatId = ctx.from?.id
  const existing = chatId ? getRegistration(chatId) : undefined
  if (existing) {
    await showRegistration(ctx, existing)
    return
  }
  if (isFull()) {
    await ctx.reply(FULL_TEXT, { parse_mode: 'HTML' })
    return
  }
  await sendOfferMessage(ctx)
}

/** Карточка «ты уже записан(а)» */
async function showRegistration(ctx: any, reg: EventRegistration): Promise<void> {
  await ctx.reply(
    `✅ Ты уже в списке гостей, ${escapeHtml(reg.name)}!\n` +
    `Ждём тебя <b>${humanDate(reg.visitDate)}</b>.\n\n${PLACE_TEXT}`,
    { parse_mode: 'HTML', reply_markup: registeredKeyboard() }
  )
}

// ─── Шаги воронки ────────────────────────────────────────────────────────

/** Нажата кнопка «Зарегистрироваться» */
export async function handleRegisterClick(ctx: any): Promise<void> {
  const chatId = ctx.from?.id
  if (!chatId) return

  const existing = getRegistration(chatId)
  if (existing) {
    await ctx.answerCallbackQuery('Ты уже записан(а) 🐆')
    await showRegistration(ctx, existing)
    return
  }

  if (isFull()) {
    await ctx.answerCallbackQuery('Мест больше нет')
    await ctx.reply(FULL_TEXT, { parse_mode: 'HTML' })
    return
  }

  await ctx.answerCallbackQuery()
  setDraft({ chatId, step: 'name', kind: 'new' })
  await ctx.reply(ASK_NAME_TEXT, { parse_mode: 'HTML' })
}

/** Нажата кнопка «Изменить дату» */
export async function handleEditDateClick(ctx: any): Promise<void> {
  const chatId = ctx.from?.id
  if (!chatId) return

  const existing = getRegistration(chatId)
  if (!existing) {
    await ctx.answerCallbackQuery('Записи не нашлось')
    await showOffer(ctx)
    return
  }

  await ctx.answerCallbackQuery()
  setDraft({ chatId, step: 'date', kind: 'edit', name: existing.name })
  await ctx.reply(`Текущая дата: <b>${humanDate(existing.visitDate)}</b>\n\nВыбери новую 👇`, {
    parse_mode: 'HTML',
    reply_markup: daysKeyboard(),
  })
}

/**
 * Сообщение от человека, заполняющего форму.
 * Возвращает true, если сообщение обработано как шаг регистрации, — тогда
 * дальше по цепочке хэндлеров идти не нужно.
 */
export async function handleDraftMessage(ctx: any, text: string | undefined): Promise<boolean> {
  const chatId = ctx.from?.id
  if (!chatId) return false

  const draft = getDraft(chatId)
  if (!draft) return false

  // На шаге даты ждём нажатия кнопки. Человек мог написать «25» текстом —
  // повторяем клавиатуру, а не роняем его в общий фолбэк «используй /start».
  if (draft.step === 'date') {
    await ctx.reply(ASK_DATE_TEXT, { reply_markup: daysKeyboard() })
    return true
  }

  const name = (text ?? '').trim().replace(/\s+/g, ' ')

  if (!name) {
    await ctx.reply('Жду имя и фамилию текстом 🐆')
    return true
  }
  if (name.startsWith('/')) {
    // команда во время формы — не считаем за имя, но и форму не рушим
    await ctx.reply('Сейчас жду имя и фамилию 🐆\nЕсли передумал(а) — просто не отвечай.')
    return true
  }
  if (name.length < 2 || name.length > 60 || !/\p{L}/u.test(name)) {
    await ctx.reply('Кажется, это не похоже на имя. Напиши имя и фамилию одним сообщением 🙏')
    return true
  }

  setDraft({ chatId, step: 'date', kind: draft.kind, name })
  await ctx.reply(ASK_DATE_TEXT, { reply_markup: daysKeyboard() })
  return true
}

/** Выбрана дата визита — финальный шаг, здесь запись становится настоящей */
export async function handleDayClick(ctx: any, date: string): Promise<void> {
  const chatId = ctx.from?.id
  if (!chatId) return

  if (!EVENT_DAYS.some(d => d.date === date)) {
    await ctx.answerCallbackQuery('Неизвестная дата')
    return
  }

  const draft = getDraft(chatId)
  const existing = getRegistration(chatId)

  // Кнопка из старого сообщения после рестарта/отмены — черновика нет.
  if (!draft) {
    await ctx.answerCallbackQuery()
    if (existing) await showRegistration(ctx, existing)
    else await showOffer(ctx)
    return
  }

  // Смена даты у существующей записи
  if (existing) {
    try {
      updateVisitDate(chatId, date)
    } catch (e: any) {
      await reportSaveFailure(ctx, chatId, e, 'смена даты')
      return
    }
    deleteDraft(chatId)
    await ctx.answerCallbackQuery('Дата изменена')
    await ctx.reply(
      `📅 Готово, перенесли на <b>${humanDate(date)}</b>.\n\n${PLACE_TEXT}`,
      { parse_mode: 'HTML', reply_markup: doneKeyboard() }
    )
    return
  }

  // Повторная проверка лимита: пока человек заполнял форму, места могли кончиться
  if (isFull()) {
    deleteDraft(chatId)
    await ctx.answerCallbackQuery('Мест больше нет')
    await ctx.reply(FULL_TEXT, { parse_mode: 'HTML' })
    return
  }

  const name = draft.name?.trim()
  if (!name) {
    await ctx.answerCallbackQuery()
    setDraft({ chatId, step: 'name', kind: 'new' })
    await ctx.reply(ASK_NAME_TEXT, { parse_mode: 'HTML' })
    return
  }

  try {
    addRegistration({
      chatId,
      name,
      username: (ctx.from?.username ?? '').replace('@', ''),
      visitDate: date,
      registeredAt: new Date().toISOString(),
    })
  } catch (e: any) {
    await reportSaveFailure(ctx, chatId, e, 'новая регистрация')
    return
  }

  deleteDraft(chatId)
  await ctx.answerCallbackQuery('Записали! 🐆')
  await ctx.reply(
    `✅ <b>${escapeHtml(name)}</b>, ты в списке гостей!\n` +
    `Ждём тебя <b>${humanDate(date)}</b>.\n\n${PLACE_TEXT}`,
    { parse_mode: 'HTML', reply_markup: doneKeyboard() }
  )

  console.log(`[event] регистрация: chat=${chatId} дата=${date} всего=${registrationCount()}/${getCapacity()}`)
}

/**
 * Файл не записался. Человеку говорим правду (черновик оставляем — можно
 * повторить), в канал уходит критический алерт: молча «терять» гостя нельзя.
 */
async function reportSaveFailure(ctx: any, chatId: number, error: any, stage: string): Promise<void> {
  console.error(`[event] не удалось сохранить регистрацию (${stage}) chat=${chatId}:`, error?.message)
  sendAlert(`Регистрация на шоурум НЕ сохранена (${stage}, chat ${chatId}): ${error?.message}`, {
    tag: 'event',
    level: 'critical',
    hint: 'файл event-registrations.json не пишется — проверьте диск и права на /opt/bot/bot',
    code: 'EVENT_SAVE_FAILED',
  }).catch(() => {})
  await ctx.answerCallbackQuery?.('Ошибка сохранения').catch(() => {})
  await ctx.reply(SAVE_FAILED_TEXT).catch(() => {})
}

/**
 * Продолжение брошенной формы по /start.
 * Возвращает true, если человек был в середине регистрации и мы её продолжили.
 */
export async function resumeDraft(ctx: any): Promise<boolean> {
  const chatId = ctx.from?.id
  if (!chatId) return false
  const draft = getDraft(chatId)
  if (!draft) return false

  if (draft.step === 'name') {
    await ctx.reply(`Продолжим регистрацию 🐆\n\n${ASK_NAME_TEXT}`, { parse_mode: 'HTML' })
  } else {
    await ctx.reply(`Продолжим регистрацию 🐆\n\n${ASK_DATE_TEXT}`, { reply_markup: daysKeyboard() })
  }
  return true
}

// ─── Выгрузка в Google Sheets ────────────────────────────────────────────
// В горячем пути регистрации сети нет вообще: человек уже получил ответ,
// строки уезжают в таблицу отсюда, пачкой и одним append на стороне бэкенда.

export const FLUSH_INTERVAL_MS = Number(process.env.EVENT_FLUSH_INTERVAL_MS ?? 30_000)
const FLUSH_BATCH = 200
/** Отставание, после которого шумим в канал ошибок */
const SYNC_LAG_ALERT_MS = 15 * 60 * 1000
const SYNC_ALERT_THROTTLE_MS = 10 * 60 * 1000

let flushInFlight = false
let lastSyncAlertAt = 0

export async function flushRegistrations(): Promise<void> {
  if (flushInFlight) return
  const batch = listUnsynced(FLUSH_BATCH)
  if (batch.length === 0) return

  flushInFlight = true
  const abortCtrl = new AbortController()
  const abortTimer = setTimeout(() => abortCtrl.abort(), 12_000)
  try {
    const secret = process.env.BOT_API_SECRET
    const url = `${BACKEND_URL}/internal/event-registrations${secret ? `?secret=${encodeURIComponent(secret)}` : ''}`
    // Bearer с токеном бота — основной способ авторизации: BOT_API_SECRET
    // в проде не задан, а эндпоинт пишет в таблицу и открытым быть не должен
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.TG_BOT_TOKEN ?? ''}`,
      },
      body: JSON.stringify({ rows: batch }),
      signal: abortCtrl.signal,
    })
    const data = await resp.json().catch(() => ({})) as any
    clearTimeout(abortTimer)

    if (!resp.ok || data?.ok !== true) {
      throw new Error(`HTTP ${resp.status} ${data?.error ?? ''}`.trim())
    }

    markSynced(batch)
    console.log(`[event-sync] выгружено в таблицу: +${data.appended ?? 0} новых, ${data.updated ?? 0} обновлено, осталось ${unsyncedCount()}`)
  } catch (e: any) {
    clearTimeout(abortTimer)
    const reason = e?.name === 'AbortError' ? 'бэкенд не ответил за 12с' : (e?.message ?? String(e))
    console.warn(`[event-sync] выгрузка не удалась: ${reason}`)
    maybeAlertSyncLag(reason)
  } finally {
    flushInFlight = false
  }
}

/**
 * Одна неудачная выгрузка — нормально (Render просыпается), регистрации при
 * этом целы в файле. Алертим, только когда отставание стало заметным, и не
 * чаще раза в 10 минут — иначе канал ошибок зальёт за час простоя.
 */
function maybeAlertSyncLag(reason: string): void {
  const pending = unsyncedCount()
  const lagMs = oldestUnsyncedAgeMs()
  if (pending < 20 && lagMs < SYNC_LAG_ALERT_MS) return

  const now = Date.now()
  if (now - lastSyncAlertAt < SYNC_ALERT_THROTTLE_MS) return
  lastSyncAlertAt = now

  sendAlert(
    `Регистрации на шоурум не уезжают в Google Sheets: ${pending} записей ждут, ` +
    `самая старая ${Math.round(lagMs / 60_000)} мин. Причина: ${reason}`,
    {
      tag: 'event',
      level: 'high',
      hint: 'сами регистрации целы в event-registrations.json на VDS — потеряна только синхронизация с таблицей',
      code: 'EVENT_SYNC_LAG',
    }
  ).catch(() => {})
}

export function startEventFlusher(): void {
  setInterval(() => { void flushRegistrations() }, FLUSH_INTERVAL_MS)
  // первый прогон сразу: после рестарта в файле может лежать невыгруженный хвост
  void flushRegistrations()
}

// ─── Менеджерские сводки ─────────────────────────────────────────────────

export function buildStatsText(): string {
  const total = registrationCount()
  const capacity = getCapacity()
  const byDate = countByDate()
  const pending = unsyncedCount()
  const lagMin = Math.round(oldestUnsyncedAgeMs() / 60_000)

  const lines = [
    '🐆 <b>Koshek Show Room — регистрации</b>',
    '',
    `Всего: <b>${total}</b> из ${capacity}${total >= capacity ? ' — мест нет' : ` (свободно ${capacity - total})`}`,
    `За последний час: ${countRegisteredSince(Date.now() - 60 * 60 * 1000)}`,
    `За сутки: ${countRegisteredSince(Date.now() - 24 * 60 * 60 * 1000)}`,
    '',
    '<b>По датам:</b>',
  ]

  for (const day of EVENT_DAYS) {
    lines.push(`${day.human}: ${byDate.get(day.date) ?? 0}`)
  }

  lines.push('')
  lines.push(
    pending === 0
      ? '📊 В таблице: всё выгружено'
      : `📊 В таблице: ждут выгрузки <b>${pending}</b> (отставание ${lagMin} мин)`
  )
  lines.push(`📝 Заполняют форму прямо сейчас: ${draftCount()}`)
  lines.push(`⚙️ Режим приглашения: <b>${getMode() === 'on' ? 'включён' : 'выключен'}</b>`)

  return lines.join('\n')
}

/** Поиск гостя по имени, нику или chat_id — сверять людей на входе */
export function buildFindText(query: string): string {
  const needle = query.trim().replace(/^@/, '').toLowerCase()
  if (needle.length < 2) return '❌ Слишком короткий запрос — минимум 2 символа.'

  const found = listRegistrations().filter(r =>
    r.name.toLowerCase().includes(needle) ||
    r.username.toLowerCase().includes(needle) ||
    String(r.chatId) === needle
  )

  if (found.length === 0) return `🔍 По запросу «${escapeHtml(query)}» никого не нашлось.`

  const shown = found.slice(0, 20)
  const lines = [`🔍 Нашлось: <b>${found.length}</b>`, '']
  for (const r of shown) {
    lines.push(
      `<b>${escapeHtml(r.name)}</b>${r.username ? ` · @${escapeHtml(r.username)}` : ''}\n` +
      `${humanDate(r.visitDate)} · <code>${r.chatId}</code>`
    )
  }
  if (found.length > shown.length) lines.push(`\n…и ещё ${found.length - shown.length}. Уточни запрос или возьми полный список: /event_list`)
  return lines.join('\n')
}

/** Только для тестов: сбрасывает кэш file_id баннера и флаги алертов */
export function __resetEventRuntimeForTests(): void {
  bannerFileId = null
  bannerMissingAlerted = false
  flushInFlight = false
  lastSyncAlertAt = 0
}

export function buildCsvFile(): InputFile {
  const stamp = new Date().toISOString().slice(0, 10)
  return new InputFile(Buffer.from(buildCsv(), 'utf8'), `koshek-showroom-${stamp}.csv`)
}
