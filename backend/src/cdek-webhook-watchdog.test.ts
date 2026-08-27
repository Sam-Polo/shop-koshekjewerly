import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.BACKEND_URL = 'https://backend.test'
process.env.CDEK_WEBHOOK_SECRET = 'sekret'
process.env.CDEK_WEBHOOK_MAX_HEALS_PER_DAY = '2'

const sendAlert = vi.fn().mockResolvedValue(undefined)
vi.mock('./alerts.js', () => ({ sendAlert: (...a: any[]) => sendAlert(...a) }))

const cdekFetch = vi.fn()
vi.mock('./cdek.js', () => ({ cdekFetch: (...a: any[]) => cdekFetch(...a) }))

const { verifyCdekWebhookSubscription, cdekWebhookUrl, _resetForTests } = await import('./cdek-webhook-watchdog.js')

const OURS = { type: 'ORDER_STATUS', url: 'https://backend.test/api/cdek/webhook?token=sekret' }

beforeEach(() => {
  sendAlert.mockClear()
  cdekFetch.mockReset()
  _resetForTests()
})

const codes = () => sendAlert.mock.calls.map(c => c[1]?.code)

describe('сторож подписки CDEK', () => {
  it('молчит, когда подписка на месте', async () => {
    cdekFetch.mockResolvedValueOnce([OURS])
    const res = await verifyCdekWebhookSubscription()
    expect(res).toMatchObject({ ok: true, healed: false })
    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('строит URL с токеном — иначе вебхуки получали бы 403', () => {
    expect(cdekWebhookUrl()).toBe(OURS.url)
  })

  it('восстанавливает пропавшую подписку и сообщает об этом', async () => {
    cdekFetch
      .mockResolvedValueOnce([])                                   // list — пусто
      .mockResolvedValueOnce({ entity: { uuid: 'new-uuid' } })     // register
    const res = await verifyCdekWebhookSubscription()
    expect(res).toMatchObject({ ok: true, healed: true })
    expect(cdekFetch).toHaveBeenCalledWith('POST', '/webhooks', { url: OURS.url, type: 'ORDER_STATUS' })
    expect(codes()).toContain('CDEK_WEBHOOK_SUBSCRIPTION_HEALED')
  })

  it('чинит и тот случай, когда подписка ведёт на чужой адрес', async () => {
    cdekFetch
      .mockResolvedValueOnce([{ type: 'ORDER_STATUS', url: 'https://someone-else/hook' }])
      .mockResolvedValueOnce({ entity: { uuid: 'u2' } })
    const res = await verifyCdekWebhookSubscription()
    expect(res.healed).toBe(true)
    expect(res.reason).toMatch(/не на нас/)
  })

  it('перестаёт чинить, если сносит слишком часто — это симптом, не причина', async () => {
    for (let i = 0; i < 2; i++) {
      cdekFetch.mockResolvedValueOnce([]).mockResolvedValueOnce({ entity: { uuid: `u${i}` } })
      await verifyCdekWebhookSubscription()
    }
    sendAlert.mockClear()
    cdekFetch.mockResolvedValueOnce([])
    const res = await verifyCdekWebhookSubscription()
    expect(res).toMatchObject({ ok: false, healed: false })
    expect(codes()).toContain('CDEK_WEBHOOK_SUBSCRIPTION_FLAPPING')
    // POST не отправляли — только list
    expect(cdekFetch).toHaveBeenLastCalledWith('GET', '/webhooks')
  })

  it('недоступность СДЭКа не выдаёт за пропажу подписки', async () => {
    cdekFetch.mockRejectedValueOnce(new Error('ECONNRESET'))
    const res = await verifyCdekWebhookSubscription()
    expect(res.ok).toBe(false)
    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('сообщает, если восстановить не удалось', async () => {

    cdekFetch.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('CDEK 500'))
    await verifyCdekWebhookSubscription()
    expect(codes()).toContain('CDEK_WEBHOOK_SUBSCRIPTION_MISSING')
  })
})
