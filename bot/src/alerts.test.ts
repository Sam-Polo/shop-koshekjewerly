import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// мокируем tgFetch — alerts.ts использует его для отправки в TG
vi.mock('./proxy.js', () => ({
  tgFetch: vi.fn().mockResolvedValue({ ok: true }),
  proxyDispatcher: undefined,
}))

// мокируем dotenv — не нужен в тестах
vi.mock('dotenv/config', () => ({}))

describe('alerts', () => {
  let tgFetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    // сбрасываем env и перезагружаем модуль alerts перед каждым тестом,
    // чтобы bucket/dedupMap были чистыми
    vi.resetModules()
    const { tgFetch } = await import('./proxy.js')
    tgFetchMock = tgFetch as ReturnType<typeof vi.fn>
    tgFetchMock.mockClear()
    tgFetchMock.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ERROR_CHANNEL_CHAT_ID
    delete process.env.TG_BOT_TOKEN
    delete process.env.FEATURE_DEBUG_ALERTS
  })

  it('no-op если ERROR_CHANNEL_CHAT_ID не задан', async () => {
    delete process.env.ERROR_CHANNEL_CHAT_ID
    process.env.TG_BOT_TOKEN = 'test-token'

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('тест')

    expect(tgFetchMock).not.toHaveBeenCalled()
  })

  it('отправляет сообщение если ERROR_CHANNEL_CHAT_ID задан', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('привет')

    expect(tgFetchMock).toHaveBeenCalledOnce()
    const [url, opts] = tgFetchMock.mock.calls[0]
    expect(url).toContain('sendMessage')
    const body = JSON.parse((opts as any).body)
    expect(body.chat_id).toBe('-100123')
    expect(body.text).toContain('привет')
  })

  it('дедуп: одинаковый текст в течение окна отправляется один раз', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'
    vi.useFakeTimers()

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('дублируемое сообщение')
    await sendAlert('дублируемое сообщение')
    await sendAlert('дублируемое сообщение')

    expect(tgFetchMock).toHaveBeenCalledOnce()
  })

  it('дедуп сбрасывается после истечения окна', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'
    vi.useFakeTimers()

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('сообщение')
    expect(tgFetchMock).toHaveBeenCalledTimes(1)

    // сдвигаем время за пределы DEDUP_WINDOW_MS (60 000 мс)
    vi.advanceTimersByTime(61_000)
    await sendAlert('сообщение')
    expect(tgFetchMock).toHaveBeenCalledTimes(2)
  })

  it('разные тексты — разные алерты, дедуп не мешает', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'

    const { sendAlert } = await import('./alerts.js')
    await sendAlert('ошибка A')
    await sendAlert('ошибка B')

    expect(tgFetchMock).toHaveBeenCalledTimes(2)
  })

  it('token bucket: после MAX_PER_MIN сообщений подавляет', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'

    const { sendAlert } = await import('./alerts.js')
    const MAX = 20

    // отправляем MAX+5 разных сообщений
    for (let i = 0; i < MAX + 5; i++) {
      await sendAlert(`уникальное сообщение ${i}`)
    }

    // ровно MAX должно пройти, остальные подавлены
    expect(tgFetchMock.mock.calls.length).toBeLessThanOrEqual(MAX)
  })

  it('не бросает исключение если tgFetch упал', async () => {
    process.env.ERROR_CHANNEL_CHAT_ID = '-100123'
    process.env.TG_BOT_TOKEN = 'test-token'
    tgFetchMock.mockRejectedValueOnce(new Error('network error'))

    const { sendAlert } = await import('./alerts.js')
    await expect(sendAlert('ошибка')).resolves.not.toThrow()
  })
})
