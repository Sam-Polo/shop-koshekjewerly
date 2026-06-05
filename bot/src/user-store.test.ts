import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('dotenv/config', () => ({}))

const { writeFileSyncMock, existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(false),
  readFileSyncMock: vi.fn().mockReturnValue('[]'),
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
  },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
}))

import { addUserChatId, userChatIds, scheduleSave } from './user-store.js'

describe('addUserChatId debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    writeFileSyncMock.mockReset()
    userChatIds.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.SAVE_DEBOUNCE_MS
  })

  it('не пишет файл сразу — только после таймера', () => {
    addUserChatId(1)

    expect(writeFileSyncMock).not.toHaveBeenCalled()

    vi.runAllTimers()

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1)
  })

  it('несколько новых пользователей подряд — один writeFileSync', () => {
    addUserChatId(1)
    addUserChatId(2)
    addUserChatId(3)

    vi.runAllTimers()

    expect(writeFileSyncMock).toHaveBeenCalledTimes(1)
    expect(userChatIds.size).toBe(3)
  })

  it('известный пользователь — не планирует сохранение', () => {
    userChatIds.add(42)

    addUserChatId(42)

    vi.runAllTimers()

    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('таймер сбрасывается при каждом новом пользователе', () => {
    addUserChatId(1)
    vi.advanceTimersByTime(1000) // не дождались — добавляем ещё
    addUserChatId(2)
    vi.advanceTimersByTime(1000) // 1000ms от ПОСЛЕДНЕГО — таймер ещё не истёк (дефолт 2000ms)
    expect(writeFileSyncMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000) // итого 2000ms после последнего addUserChatId — должен сработать
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1)
  })
})
