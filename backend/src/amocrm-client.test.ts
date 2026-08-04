import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// env читается на импорте модуля — задаём до динамического import ниже
process.env.AMOCRM_SUBDOMAIN = 'test'
process.env.AMOCRM_ACCESS_TOKEN = 'token'
process.env.AMOCRM_MIN_INTERVAL_MS = '20'   // короткий интервал, чтобы тесты были быстрыми
process.env.AMOCRM_QUEUE_DEPTH_ALERT = '1000'

const sendAlert = vi.fn().mockResolvedValue(undefined)
vi.mock('./alerts.js', () => ({ sendAlert: (...a: any[]) => sendAlert(...a) }))

let client: typeof import('./amocrm-client.js')

// ── мок fetch: пишет порядок и тайминги вызовов ───────────────────────────────
type Call = { path: string; startedAt: number }
let calls: Call[] = []
let inFlight = 0
let maxInFlight = 0
/** path → сколько раз ответить 429 перед успехом */
let rateLimited: Record<string, number> = {}
/** path → HTTP-код ошибки вместо успеха */
let failWith: Record<string, number> = {}
let latencyMs = 5

function makeResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace('https://test.amocrm.ru/api/v4', '')
    calls.push({ path, startedAt: Date.now() })
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(r => setTimeout(r, latencyMs))
    inFlight--

    if (rateLimited[path] > 0) {
      rateLimited[path]--
      return makeResponse(429, {})
    }
    if (failWith[path]) return makeResponse(failWith[path], { detail: 'nope' })
    return makeResponse(200, { path })
  })
  client = await import('./amocrm-client.js')
})

beforeEach(() => {
  calls = []
  inFlight = 0
  maxInFlight = 0
  rateLimited = {}
  failWith = {}
  latencyMs = 5
  sendAlert.mockClear()
})

describe('очередь amoCRM', () => {
  it('не теряет ни одного запроса при массовом наплыве', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => client.amoFetch('GET', `/leads/${i}`, undefined, 'low'))
    )
    expect(results).toHaveLength(30)
    expect(calls).toHaveLength(30)
    // очередь пуста — ничего не зависло
    expect(client.queueDepth().total).toBe(0)
  })

  it('шлёт запросы по одному, не создавая всплеска', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => client.amoFetch('GET', `/leads/${i}`, undefined, 'low'))
    )
    expect(maxInFlight).toBe(1)
  })

  it('выдерживает паузу между стартами запросов', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.amoFetch('GET', `/leads/${i}`, undefined, 'low'))
    )
    for (let i = 1; i < calls.length; i++) {
      const gap = calls[i].startedAt - calls[i - 1].startedAt
      expect(gap).toBeGreaterThanOrEqual(15) // 20 мс минус допуск на таймеры
    }
  })

  it('пропускает заказы вперёд фоновых задач', async () => {
    const pending: Promise<unknown>[] = []
    // первый low сразу уходит в работу, остальные встают в очередь
    for (let i = 0; i < 5; i++) pending.push(client.amoFetch('GET', `/low/${i}`, undefined, 'low'))
    pending.push(client.amoFetch('POST', '/leads', [{}], 'high'))
    await Promise.all(pending)

    const order = calls.map(c => c.path)
    expect(order[0]).toBe('/low/0')      // успел стартовать до постановки high
    expect(order[1]).toBe('/leads')      // заказ обогнал оставшийся фон
    expect(order.slice(2)).toEqual(['/low/1', '/low/2', '/low/3', '/low/4'])
  })

  it('не застревает, если один запрос упал', async () => {
    failWith['/leads/bad'] = 500
    const bad = client.amoFetch('GET', '/leads/bad', undefined, 'low')
    const good = client.amoFetch('GET', '/leads/good', undefined, 'low')

    await expect(bad).rejects.toThrow(/HTTP 500/)
    await expect(good).resolves.toEqual({ path: '/leads/good' })
    expect(client.queueDepth().total).toBe(0)
  })

  it('повторяет запрос после 429 и в итоге отдаёт результат', async () => {
    rateLimited['/leads/429'] = 2
    const res = await client.amoFetch('GET', '/leads/429', undefined, 'low')
    expect(res).toEqual({ path: '/leads/429' })
    expect(calls.filter(c => c.path === '/leads/429')).toHaveLength(3) // 2 отказа + успех
  })
})

describe('алерты клиента amoCRM', () => {
  it('критично алертит на 403 — это блокировка интеграции', async () => {
    failWith['/account'] = 403
    await expect(client.amoFetch('GET', '/account')).rejects.toThrow(/HTTP 403/)
    const call = sendAlert.mock.calls.find(c => c[1]?.code === 'AMOCRM_ACCESS_FORBIDDEN')
    expect(call).toBeDefined()
    expect(call![1].level).toBe('critical')
  })

  it('критично алертит на 401 — токен отозван', async () => {
    failWith['/account'] = 401
    await expect(client.amoFetch('GET', '/account')).rejects.toThrow(/HTTP 401/)
    const call = sendAlert.mock.calls.find(c => c[1]?.code === 'AMOCRM_TOKEN_INVALID')
    expect(call).toBeDefined()
    expect(call![1].level).toBe('critical')
  })

  it('не алертит на обычной ошибке — ретраи и алерты остаются на вызывающем коде', async () => {
    failWith['/leads/500'] = 500
    await expect(client.amoFetch('GET', '/leads/500')).rejects.toThrow(/HTTP 500/)
    expect(sendAlert).not.toHaveBeenCalled()
  })
})
