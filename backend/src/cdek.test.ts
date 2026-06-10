import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Set env before module import
process.env.CDEK_CLIENT_ID = 'test-client-id'
process.env.CDEK_CLIENT_SECRET = 'test-secret'
process.env.CDEK_BASE_URL = 'https://api.edu.cdek.ru/v2'

let cdek: typeof import('./cdek.js')

const TOKEN_RESP = { access_token: 'tok-123', expires_in: 3600 }

const CITY_RESP = [
  { code: 44, full_name: 'Москва, Россия', country_code: 'RU' },
  { code: 270, full_name: 'Санкт-Петербург, г. Санкт-Петербург, Россия', country_code: 'RU' },
]

const PVZ_RESP = [
  { code: 'MSK1', name: 'ПВЗ Центр', location: { address: 'ул. Тверская, 1' }, work_time: 'Пн-Вс 9:00-21:00' },
  { code: 'MSK2', name: 'ПВЗ Север', location: { address: 'Ленинградский пр., 80' } },
]

const CALC_RESP = { delivery_sum: 350.5, period_min: 2, period_max: 3 }

const ORDER_RESP = {
  entity: { uuid: 'uuid-abc', cdek_number: null },
  requests: [{ state: 'ACCEPTED', errors: [] }],
}

const ORDER_WITH_TRACK_RESP = {
  entity: { uuid: 'uuid-abc', cdek_number: '1234567890' },
  requests: [{ state: 'ACCEPTED', errors: [] }],
}

function mockFetch(responses: Array<{ ok: boolean; body: unknown }>) {
  let call = 0
  return vi.fn(async () => {
    const resp = responses[call] ?? responses[responses.length - 1]
    call++
    return {
      ok: resp.ok,
      status: resp.ok ? 200 : 400,
      text: async () => JSON.stringify(resp.body),
      json: async () => resp.body,
    }
  })
}

beforeEach(async () => {
  cdek = await import('./cdek.js')
  cdek._resetTokenCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getToken', () => {
  it('fetches token on first call', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: TOKEN_RESP }]))
    const token = await cdek.getToken()
    expect(token).toBe('tok-123')
    expect((fetch as any).mock.calls).toHaveLength(1)
  })

  it('returns cached token on second call', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: TOKEN_RESP }]))
    await cdek.getToken()
    await cdek.getToken()
    expect((fetch as any).mock.calls).toHaveLength(1)
  })

  it('throws when credentials missing', async () => {
    const origId = process.env.CDEK_CLIENT_ID
    delete process.env.CDEK_CLIENT_ID
    await expect(cdek.getToken()).rejects.toThrow('CDEK_CLIENT_ID')
    process.env.CDEK_CLIENT_ID = origId
  })

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: false, body: { error: 'unauthorized' } }]))
    await expect(cdek.getToken()).rejects.toThrow('HTTP 400')
  })
})

describe('searchCities', () => {
  it('returns mapped city list', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: CITY_RESP },
    ]))
    const cities = await cdek.searchCities('Мос')
    expect(cities).toHaveLength(2)
    expect(cities[0]).toMatchObject({ code: 44, city: 'Москва', region: undefined, country_code: 'RU' })
    expect(cities[1]).toMatchObject({ code: 270, city: 'Санкт-Петербург', region: 'г. Санкт-Петербург' })
  })

  it('returns [] on non-array response', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: {} },
    ]))
    const cities = await cdek.searchCities('X')
    expect(cities).toEqual([])
  })
})

describe('getPickupPoints', () => {
  it('returns mapped PVZ list', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: PVZ_RESP },
    ]))
    const pvz = await cdek.getPickupPoints(44)
    expect(pvz).toHaveLength(2)
    expect(pvz[0]).toMatchObject({ code: 'MSK1', address: 'ул. Тверская, 1', work_time: 'Пн-Вс 9:00-21:00' })
    expect(pvz[1]).toMatchObject({ code: 'MSK2', address: 'Ленинградский пр., 80' })
  })

  it('passes city_code query param', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: [] },
    ]))
    await cdek.getPickupPoints(270)
    const calls = (fetch as any).mock.calls as [string, ...any[]][]
    const pvzCall = calls[1][0] as string
    expect(pvzCall).toContain('city_code=270')
  })
})

describe('calculateDelivery', () => {
  it('returns ceiling of delivery_sum', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: CALC_RESP },
    ]))
    const cost = await cdek.calculateDelivery(270)
    expect(cost).toBe(351)
  })

  it('throws when delivery_sum missing', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: { period_min: 2 } },
    ]))
    await expect(cdek.calculateDelivery(270)).rejects.toThrow('no delivery_sum')
  })

  it('posts tariff 136 with correct package dimensions', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: CALC_RESP },
    ]))
    await cdek.calculateDelivery(44)
    const calls = (fetch as any).mock.calls as [string, RequestInit][]
    const body = JSON.parse(calls[1][1].body as string)
    expect(body.tariff_code).toBe(136)
    expect(body.packages[0]).toMatchObject({ weight: 200, length: 15, width: 15, height: 5 })
  })
})

describe('createCdekOrder', () => {
  const order = {
    orderId: 'ORD-001',
    status: 'paid' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    platform: 'telegram' as const,
    customerChatId: '12345',
    customerName: 'Иван',
    orderData: {
      items: [
        { slug: 'ring-silver', title: 'Кольцо серебро', price: 5000, quantity: 1 },
        { slug: 'earrings-gold', title: 'Серьги золото', price: 3000, quantity: 2 },
      ],
      fullName: 'Иванов Иван Иванович',
      phone: '+79001234567',
      country: 'Россия',
      city: 'Санкт-Петербург',
      address: 'ПВЗ ул. Тверская, 1',
      deliveryRegion: '',
      deliveryCost: 350,
      total: 11350,
      pvzCode: 'SPB1',
    },
  }

  it('returns uuid from response', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: ORDER_RESP },
    ]))
    const result = await cdek.createCdekOrder(order, 'SPB1')
    expect(result.uuid).toBe('uuid-abc')
    expect(result.cdekNumber).toBeNull()
  })

  it('returns cdekNumber when present in response', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: ORDER_WITH_TRACK_RESP },
    ]))
    const result = await cdek.createCdekOrder(order, 'SPB1')
    expect(result.cdekNumber).toBe('1234567890')
  })

  it('throws when uuid missing', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: { entity: {}, requests: [{ state: 'INVALID', errors: [{ message: 'pvz not found' }] }] } },
    ]))
    await expect(cdek.createCdekOrder(order, 'BAD')).rejects.toThrow('no uuid')
  })

  it('sends correct recipient and delivery_point', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: ORDER_RESP },
    ]))
    await cdek.createCdekOrder(order, 'SPB1')
    const calls = (fetch as any).mock.calls as [string, RequestInit][]
    const body = JSON.parse(calls[1][1].body as string)
    expect(body.delivery_point).toBe('SPB1')
    expect(body.recipient.name).toBe('Иванов Иван Иванович')
    expect(body.recipient.phones[0].number).toBe('+79001234567')
    expect(body.tariff_code).toBe(136)
  })
})

describe('getCdekTrackNumber', () => {
  it('returns cdek_number', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: ORDER_WITH_TRACK_RESP },
    ]))
    const track = await cdek.getCdekTrackNumber('uuid-abc')
    expect(track).toBe('1234567890')
  })

  it('returns null when cdek_number not yet assigned', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: TOKEN_RESP },
      { ok: true, body: ORDER_RESP },
    ]))
    const track = await cdek.getCdekTrackNumber('uuid-abc')
    expect(track).toBeNull()
  })
})
