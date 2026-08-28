import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.BACKEND_URL = 'https://backend.test'
process.env.CDEK_WEBHOOK_SECRET = 'sekret'
process.env.CDEK_WEBHOOK_MAX_HEALS_PER_DAY = '2'
process.env.CDEK_WEBHOOK_RECHECK_DELAY_MS = '0'   // в тестах не ждём

const sendAlert = vi.fn().mockResolvedValue(undefined)
vi.mock('./alerts.js', () => ({ sendAlert: (...a: any[]) => sendAlert(...a) }))

const cdekFetch = vi.fn()
vi.mock('./cdek.js', () => ({ cdekFetch: (...a: any[]) => cdekFetch(...a) }))

const { verifyCdekWebhookSubscription, cdekWebhookUrl, _resetForTests } =
  await import('./cdek-webhook-watchdog.js')

const OURS = { type: 'ORDER_STATUS', url: 'https://backend.test/api/cdek/webhook?token=sekret' }
const FOREIGN = { type: 'ORDER_STATUS', url: 'https://someone-else/hook' }

beforeEach(() => {
  sendAlert.mockClear()
  cdekFetch.mockReset()
  _resetForTests()
})

const codes = () => sendAlert.mock.calls.map(c => c[1]?.code)
const levelOf = (code: string) => sendAlert.mock.calls.find(c => c[1]?.code === code)?.[1]?.level

/** Успешное лечение: пусто → перепроверка пусто → POST → проверка закрепления. */
function mockHealSequence(after: any[] = [OURS]) {
  cdekFetch
    .mockResolvedValueOnce([])                                // list
    .mockResolvedValueOnce([])                                // перепроверка
    .mockResolvedValueOnce({ entity: { uuid: 'new-uuid' } })  // POST
    .mockResolvedValueOnce(after)                             // проверка закрепления
}

describe('сторож подписки CDEK', () => {
  it('строит URL с токеном — иначе вебхуки получали бы 403', () => {
    expect(cdekWebhookUrl()).toBe(OURS.url)
  })

  it('молчит, когда подписка на месте', async () => {
    cdekFetch.mockResolvedValueOnce([OURS])
    const res = await verifyCdekWebhookSubscription()
    expect(res).toMatchObject({ ok: true, healed: false })
    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('не заводит вторую подписку из-за разового пустого ответа', async () => {
    cdekFetch
      .mockResolvedValueOnce([])       // list — пусто
      .mockResolvedValueOnce([OURS])   // перепроверка — на месте
    const res = await verifyCdekWebhookSubscription()
    expect(res).toMatchObject({ ok: true, healed: false })
    expect(sendAlert).not.toHaveBeenCalled()
    // POST не отправляли
    expect(cdekFetch.mock.calls.every(c => c[0] === 'GET')).toBe(true)
  })

  it('восстанавливает подписку, если её нет и при перепроверке', async () => {
    mockHealSequence()
    const res = await verifyCdekWebhookSubscription()
    expect(res).toMatchObject({ ok: true, healed: true })
    expect(cdekFetch).toHaveBeenCalledWith('POST', '/webhooks', { url: OURS.url, type: 'ORDER_STATUS' })
    expect(codes()).toContain('CDEK_WEBHOOK_SUBSCRIPTION_HEALED')
    expect(levelOf('CDEK_WEBHOOK_SUBSCRIPTION_HEALED')).toBe('high')
  })

  it('поднимает уровень, если регистрация не закрепилась', async () => {
    mockHealSequence([])  // после POST подписки всё равно нет
    const res = await verifyCdekWebhookSubscription()
    expect(res.ok).toBe(false)
    expect(levelOf('CDEK_WEBHOOK_SUBSCRIPTION_HEALED')).toBe('critical')
  })

  it('чинит и случай, когда подписка ведёт на чужой адрес', async () => {
    cdekFetch
      .mockResolvedValueOnce([FOREIGN])
      .mockResolvedValueOnce([FOREIGN])
      .mockResolvedValueOnce({ entity: { uuid: 'u2' } })
      .mockResolvedValueOnce([OURS])
    const res = await verifyCdekWebhookSubscription()
    expect(res.healed).toBe(true)
    expect(res.reason).toMatch(/не на нас/)
  })

  it('перестаёт чинить, если сносит слишком часто — это симптом, не причина', async () => {
    for (let i = 0; i < 2; i++) {
      mockHealSequence()
      await verifyCdekWebhookSubscription()
    }
    sendAlert.mockClear()
    const before = cdekFetch.mock.calls.length   // POST'ы из подготовки не считаем
    cdekFetch.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    const res = await verifyCdekWebhookSubscription()
    expect(res).toMatchObject({ ok: false, healed: false })
    expect(codes()).toContain('CDEK_WEBHOOK_SUBSCRIPTION_FLAPPING')
    // POST не отправляли — только чтения
    expect(cdekFetch.mock.calls.slice(before).every(c => c[0] === 'GET')).toBe(true)
  })

  it('не повторяет critical о flapping каждые полчаса', async () => {
    for (let i = 0; i < 2; i++) {
      mockHealSequence()
      await verifyCdekWebhookSubscription()
    }
    cdekFetch.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await verifyCdekWebhookSubscription()          // первый flapping — алертит
    sendAlert.mockClear()
    cdekFetch.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await verifyCdekWebhookSubscription()          // второй подряд — молчит
    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('недоступность СДЭКа не выдаёт за пропажу подписки', async () => {
    cdekFetch.mockRejectedValueOnce(new Error('ECONNRESET'))
    const res = await verifyCdekWebhookSubscription()
    expect(res.ok).toBe(false)
    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('сообщает, если восстановить не удалось', async () => {
    cdekFetch
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('CDEK 500'))
    await verifyCdekWebhookSubscription()
    expect(codes()).toContain('CDEK_WEBHOOK_SUBSCRIPTION_MISSING')
  })
})
