import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// мокируем dotenv — не нужен в тестах
vi.mock('dotenv/config', () => ({}))

// мокируем глобальный fetch
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

describe('alerts (backend)', () => {
  beforeEach(async () => {
    vi.resetModules()
    fetchMock.mockClear()
    fetchMock.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ERROR_CHANNEL_CHAT_ID
    delete process.env.TG_BOT_TOKEN
  })

  it('no-op если ERROR_CHANNEL_CHAT_ID не задан', async () => {
    delete process.env.ERROR_CHANNEL_CHAT_ID
    process.env.TG_BOT_TOKEN = 'test-token'

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('тест')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('отправляет если ERROR_CHANNEL_CHAT_ID задан', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('привет')

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('sendMessage')
    const body = JSON.parse((opts as any).body)
    expect(body.chat_id).toBe('-100123')
    expect(body.text).toContain('привет')
  })

  it('дедуп: одинаковый текст в окне — одна отправка', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'
    vi.useFakeTimers()

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('дублируемое')
    await sendAlert('дублируемое')
    await sendAlert('дублируемое')

    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('дедуп сбрасывается после 60 с', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'
    vi.useFakeTimers()

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('сообщение')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(61_000)
    await sendAlert('сообщение')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('token bucket: подавляет после MAX_PER_MIN', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'

    const { sendAlert } = await import('./alerts.js')
    for (let i = 0; i < 25; i++) {
      await sendAlert(`уникальное сообщение ${i}`)
    }

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(20)
  })

  it('не бросает если fetch упал', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'
    fetchMock.mockRejectedValueOnce(new Error('network error'))

    const { sendAlert } = await import('./alerts.js')
    await expect(sendAlert('ошибка')).resolves.not.toThrow()
  })
})
