import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('dotenv/config', () => ({}))
// alerts тянут за собой proxy/fetch — в тестах воронки нам нужен только факт вызова
vi.mock('./alerts.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }))

import {
  showOffer, handleRegisterClick, handleDraftMessage, handleDayClick,
  handleEditDateClick, resumeDraft, EVENT_DAYS, PLACE_TEXT, OFFER_TEXT,
  __resetEventRuntimeForTests,
} from './event.js'
import {
  __resetForTests, getRegistration, registrationCount, setCapacity, getDraft,
} from './event-store.js'

let tmpDir: string

type Sent = { text?: string; photo?: unknown; opts?: any }

function makeCtx(chatId: number, username = 'kitty') {
  const sent: Sent[] = []
  const answers: string[] = []
  return {
    from: { id: chatId, username },
    chat: { id: chatId, type: 'private' },
    sent,
    answers,
    reply: vi.fn(async (text: string, opts?: any) => { sent.push({ text, opts }); return { message_id: sent.length } }),
    replyWithPhoto: vi.fn(async (photo: unknown, opts?: any) => {
      sent.push({ photo, text: opts?.caption, opts })
      return { message_id: sent.length, photo: [{ file_id: 'BANNER_FILE_ID' }] }
    }),
    answerCallbackQuery: vi.fn(async (text?: string) => { answers.push(text ?? '') }),
  }
}

function lastSent(ctx: ReturnType<typeof makeCtx>): Sent {
  return ctx.sent[ctx.sent.length - 1]
}

function buttonTexts(sent: Sent): string[] {
  const rows = sent.opts?.reply_markup?.inline_keyboard ?? []
  return rows.flat().map((b: any) => b.text)
}

/** Проходит воронку целиком: приглашение → имя → дата */
async function registerFully(chatId: number, date = EVENT_DAYS[0].date, name = 'Аня Котова') {
  const ctx = makeCtx(chatId)
  await handleRegisterClick(ctx)
  await handleDraftMessage(ctx, name)
  await handleDayClick(ctx, date)
  return ctx
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koshek-event-flow-'))
  process.env.EVENT_DATA_DIR = tmpDir
  __resetForTests()
  __resetEventRuntimeForTests()   // кэш file_id баннера живёт в модуле
})

afterEach(() => {
  __resetForTests()
  delete process.env.EVENT_DATA_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('приглашение', () => {
  it('новому показывается баннер с текстом и одной кнопкой регистрации', async () => {
    const ctx = makeCtx(111)

    await showOffer(ctx)

    const msg = lastSent(ctx)
    expect(msg.photo).toBeDefined()
    expect(msg.text).toBe(OFFER_TEXT)
    // вторая кнопка в мини-апп здесь намеренно отсутствует: приоритет у регистрации
    expect(buttonTexts(msg)).toEqual(['Зарегистрироваться 🐆'])
  })

  it('баннер грузится с диска один раз, дальше уходит по file_id', async () => {
    const first = makeCtx(111)
    await showOffer(first)
    const second = makeCtx(222)
    await showOffer(second)

    // первый раз — файл, второй — строка file_id: иначе на анонсе картинка
    // заливалась бы в Telegram на каждый /start
    expect(typeof first.replyWithPhoto.mock.calls[0][0]).toBe('object')
    expect(second.replyWithPhoto.mock.calls[0][0]).toBe('BANNER_FILE_ID')
  })

  it('уже записанному показывается его дата, а не приглашение заново', async () => {
    await registerFully(111, '2026-09-25')

    const ctx = makeCtx(111)
    await showOffer(ctx)

    const msg = lastSent(ctx)
    expect(msg.photo).toBeUndefined()
    expect(msg.text).toContain('25 сентября')
    expect(buttonTexts(msg)).toContain('Изменить дату 📅')
  })
})

describe('воронка', () => {
  it('доводит до записи и финального сообщения с адресом', async () => {
    const ctx = await registerFully(111, '2026-09-24', 'Аня Котова')

    const reg = getRegistration(111)
    expect(reg?.name).toBe('Аня Котова')
    expect(reg?.username).toBe('kitty')
    expect(reg?.visitDate).toBe('2026-09-24')

    const final = lastSent(ctx)
    expect(final.text).toContain(PLACE_TEXT)
    expect(final.text).toContain('24 сентября')
    // кнопка в мини-апп появляется в конце — воронка уже пройдена
    expect(buttonTexts(final)).toEqual(['KOSHEK JEWERLY🐾'])
  })

  it('предлагает ровно пять дат мероприятия', async () => {
    const ctx = makeCtx(111)
    await handleRegisterClick(ctx)
    await handleDraftMessage(ctx, 'Аня Котова')

    expect(buttonTexts(lastSent(ctx))).toEqual(EVENT_DAYS.map(d => d.button))
  })

  it('лишние пробелы в имени схлопываются', async () => {
    await registerFully(111, EVENT_DAYS[0].date, '  Аня   Котова  ')
    expect(getRegistration(111)?.name).toBe('Аня Котова')
  })

  it('мусор вместо имени не двигает форму дальше', async () => {
    const ctx = makeCtx(111)
    await handleRegisterClick(ctx)

    await handleDraftMessage(ctx, '...')

    expect(getDraft(111)?.step).toBe('name')
    expect(lastSent(ctx).text).toContain('не похоже на имя')
  })

  it('нетекстовое сообщение на шаге имени не ломает форму', async () => {
    const ctx = makeCtx(111)
    await handleRegisterClick(ctx)

    await handleDraftMessage(ctx, undefined)

    expect(getDraft(111)?.step).toBe('name')
  })

  it('текст вместо кнопки на шаге даты повторяет клавиатуру', async () => {
    const ctx = makeCtx(111)
    await handleRegisterClick(ctx)
    await handleDraftMessage(ctx, 'Аня Котова')

    const handled = await handleDraftMessage(ctx, '25')

    expect(handled).toBe(true)
    expect(buttonTexts(lastSent(ctx))).toEqual(EVENT_DAYS.map(d => d.button))
  })

  it('сообщение вне формы не перехватывается', async () => {
    const ctx = makeCtx(111)
    expect(await handleDraftMessage(ctx, 'привет')).toBe(false)
    expect(ctx.sent).toHaveLength(0)
  })

  it('брошенная форма продолжается с прерванного шага', async () => {
    const ctx = makeCtx(111)
    await handleRegisterClick(ctx)
    await handleDraftMessage(ctx, 'Аня Котова')

    const resumed = makeCtx(111)
    expect(await resumeDraft(resumed)).toBe(true)
    expect(buttonTexts(lastSent(resumed))).toEqual(EVENT_DAYS.map(d => d.button))
  })

  it('кнопка даты из старого сообщения без черновика не создаёт записи', async () => {
    const ctx = makeCtx(111)

    await handleDayClick(ctx, EVENT_DAYS[0].date)

    expect(registrationCount()).toBe(0)
    expect(lastSent(ctx).photo).toBeDefined()  // показали приглашение заново
  })

  it('подделанная дата в callback отбрасывается', async () => {
    const ctx = makeCtx(111)
    await handleRegisterClick(ctx)
    await handleDraftMessage(ctx, 'Аня Котова')

    await handleDayClick(ctx, '2026-12-31')

    expect(registrationCount()).toBe(0)
  })
})

describe('лимит мест', () => {
  it('не пускает в форму, когда мест нет', async () => {
    setCapacity(1)
    await registerFully(111)

    const ctx = makeCtx(222)
    await handleRegisterClick(ctx)

    expect(getDraft(222)).toBeUndefined()
    expect(lastSent(ctx).text).toContain('Регистрация закрыта')
    expect(lastSent(ctx).text).toContain('вход свободный')
  })

  it('места кончились, пока человек заполнял форму — записи не будет', async () => {
    setCapacity(2)
    const ctx = makeCtx(222)
    await handleRegisterClick(ctx)          // место ещё было
    await handleDraftMessage(ctx, 'Аня Котова')

    await registerFully(333)                // кто-то занял последнее
    await registerFully(444)

    await handleDayClick(ctx, EVENT_DAYS[0].date)

    expect(getRegistration(222)).toBeUndefined()
    expect(lastSent(ctx).text).toContain('Регистрация закрыта')
  })

  it('уже записанный не упирается в лимит при смене даты', async () => {
    await registerFully(111, '2026-09-23')
    setCapacity(1)

    const ctx = makeCtx(111)
    await handleEditDateClick(ctx)
    await handleDayClick(ctx, '2026-09-27')

    expect(getRegistration(111)?.visitDate).toBe('2026-09-27')
    expect(lastSent(ctx).text).toContain('перенесли')
  })
})

describe('смена даты', () => {
  it('не спрашивает имя заново', async () => {
    await registerFully(111, '2026-09-23', 'Аня Котова')

    const ctx = makeCtx(111)
    await handleEditDateClick(ctx)

    expect(getDraft(111)?.step).toBe('date')
    expect(buttonTexts(lastSent(ctx))).toEqual(EVENT_DAYS.map(d => d.button))
  })

  it('без существующей записи уводит на приглашение', async () => {
    const ctx = makeCtx(111)
    await handleEditDateClick(ctx)

    expect(lastSent(ctx).photo).toBeDefined()
  })
})
