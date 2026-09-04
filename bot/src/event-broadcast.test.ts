import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('dotenv/config', () => ({}))
vi.mock('./alerts.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }))

// быстрый прогон: пауза между отправками не нужна в тестах
process.env.EVENT_BROADCAST_PACE_MS = '0'
process.env.EVENT_BROADCAST_REPORT_EVERY = '100000'

import {
  __resetBroadcastForTests, loadBroadcastState, notifiedCount, selectTargets,
  startBroadcastDetached, isBroadcastRunning, requestBroadcastStop, wasNotified,
} from './event-broadcast.js'
import { __resetForTests, addRegistration } from './event-store.js'
import { __resetEventRuntimeForTests } from './event.js'

let tmpDir: string

/** Telegram-ошибка в том виде, в каком её отдаёт grammY */
function tgError(code: number, description: string) {
  return Object.assign(new Error(description), { error_code: code, description })
}

function makeApi(behaviour: (chatId: number) => void = () => {}) {
  const photoCalls: number[] = []
  const messages: Array<{ chatId: number; text: string }> = []
  return {
    photoCalls,
    messages,
    sendPhoto: vi.fn(async (chatId: number, _photo: unknown, _opts?: unknown) => {
      behaviour(chatId)
      photoCalls.push(chatId)
      return { message_id: photoCalls.length, photo: [{ file_id: 'BANNER_FILE_ID' }] }
    }),
    sendMessage: vi.fn(async (chatId: number, text: string) => {
      messages.push({ chatId, text })
      return { message_id: messages.length }
    }),
  }
}

/** Ждёт, пока отвязанный цикл рассылки закончится */
async function waitForBroadcast(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isBroadcastRunning()) {
    if (Date.now() > deadline) throw new Error('рассылка не завершилась')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function register(chatId: number) {
  addRegistration({
    chatId,
    name: `Гость ${chatId}`,
    username: '',
    visitDate: '2026-09-23',
    registeredAt: new Date().toISOString(),
  })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koshek-bc-'))
  process.env.EVENT_DATA_DIR = tmpDir
  __resetForTests()
  __resetBroadcastForTests()
  __resetEventRuntimeForTests()   // кэш file_id баннера живёт в модуле event.ts
})

afterEach(() => {
  __resetForTests()
  __resetBroadcastForTests()
  delete process.env.EVENT_DATA_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('выбор получателей', () => {
  it('исключает уже записавшихся', () => {
    register(111)

    const { targets, registered } = selectTargets([111, 222, 333])

    expect(targets).toEqual([222, 333])
    expect(registered).toBe(1)
  })

  it('исключает тех, кому приглашение уже уходило', async () => {
    const api = makeApi()
    startBroadcastDetached(api, [111, 222], 999)
    await waitForBroadcast()

    const { targets, alreadyNotified } = selectTargets([111, 222, 333])

    expect(targets).toEqual([333])
    expect(alreadyNotified).toBe(2)
  })

  it('отбрасывает мусорные chat_id', () => {
    const { targets } = selectTargets([111, 'не число', 0, -5])
    expect(targets).toEqual([111])
  })
})

describe('прогон рассылки', () => {
  it('отправляет пост каждому получателю', async () => {
    const api = makeApi()

    startBroadcastDetached(api, [111, 222, 333], 999)
    await waitForBroadcast()

    expect(api.photoCalls).toEqual([111, 222, 333])
    expect(notifiedCount()).toBe(3)
  })

  it('картинка грузится с диска один раз, дальше по file_id', async () => {
    const api = makeApi()

    startBroadcastDetached(api, [111, 222, 333], 999)
    await waitForBroadcast()

    // первый вызов — InputFile (объект), остальные — строка file_id
    expect(typeof api.sendPhoto.mock.calls[0][1]).toBe('object')
    expect(api.sendPhoto.mock.calls[1][1]).toBe('BANNER_FILE_ID')
    expect(api.sendPhoto.mock.calls[2][1]).toBe('BANNER_FILE_ID')
  })

  it('заблокировавшие бота считаются отдельно и не мешают остальным', async () => {
    const api = makeApi(chatId => {
      if (chatId === 222) throw tgError(403, 'Forbidden: bot was blocked by the user')
    })

    startBroadcastDetached(api, [111, 222, 333], 999)
    await waitForBroadcast()

    const report = api.messages[api.messages.length - 1].text
    expect(report).toContain('Доставлено: 2')
    expect(report).toContain('Заблокировали бота: 1')
    expect(report).toContain('Ошибок: 0')
  })

  it('заблокировавшего не пытаемся оповестить повторно', async () => {
    const api = makeApi(chatId => {
      if (chatId === 222) throw tgError(403, 'Forbidden: bot was blocked by the user')
    })
    startBroadcastDetached(api, [111, 222], 999)
    await waitForBroadcast()

    expect(wasNotified(222)).toBe(true)
    expect(selectTargets([111, 222]).targets).toEqual([])
  })

  it('прочие ошибки не роняют рассылку и попадают в итог', async () => {
    const api = makeApi(chatId => {
      if (chatId === 222) throw tgError(500, 'Internal Server Error')
    })

    startBroadcastDetached(api, [111, 222, 333], 999)
    await waitForBroadcast()

    expect(api.photoCalls).toEqual([111, 333])
    const report = api.messages[api.messages.length - 1].text
    expect(report).toContain('Ошибок: 1')
    // неудачного НЕ помечаем оповещённым — повторный прогон его дошлёт
    expect(selectTargets([111, 222, 333]).targets).toEqual([222])
  })

  it('второй запуск поверх идущего игнорируется', async () => {
    const api = makeApi()
    startBroadcastDetached(api, [111, 222, 333], 999)
    startBroadcastDetached(api, [444, 555], 999)
    await waitForBroadcast()

    expect(api.photoCalls).not.toContain(444)
  })

  it('остановка прекращает рассылку и сообщает про остаток', async () => {
    const api = makeApi(chatId => {
      if (chatId === 111) requestBroadcastStop()
    })

    startBroadcastDetached(api, [111, 222, 333], 999)
    await waitForBroadcast()

    expect(api.photoCalls).toEqual([111])
    const report = api.messages[api.messages.length - 1].text
    expect(report).toContain('остановлена')
    expect(report).toContain('Не отправлено: 2')
  })
})

describe('устойчивость к рестарту', () => {
  it('оповещённые переживают перезапуск и не получают повтор', async () => {
    const api = makeApi()
    startBroadcastDetached(api, [111, 222], 999)
    await waitForBroadcast()

    __resetBroadcastForTests()      // имитируем рестарт процесса
    expect(notifiedCount()).toBe(0)
    loadBroadcastState()

    expect(notifiedCount()).toBe(2)
    expect(selectTargets([111, 222, 333]).targets).toEqual([333])
  })

  it('битый файл состояния не роняет бота', () => {
    fs.writeFileSync(path.join(tmpDir, 'event-broadcast.json'), 'не json', 'utf8')

    expect(() => loadBroadcastState()).not.toThrow()
    expect(notifiedCount()).toBe(0)
  })
})
