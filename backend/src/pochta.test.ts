import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Set env before module import
process.env.POCHTA_API_BASE = 'https://otpravka-api.pochta.ru'
process.env.POCHTA_TOKEN = 'access-token-123'
process.env.POCHTA_LOGIN = 'login@example.com'
process.env.POCHTA_PASSWORD = 'secret'
process.env.POCHTA_INDEX_FROM = '121471'

let pochta: typeof import('./pochta.js')

const TARIFF_RESP = { 'total-rate': 50000, 'total-vat': 10000 } // 600 ₽

const ORDER_RESP = { 'result-ids': [777], errors: [], total: 1 }
const BATCH_RESP = [{ 'batch-name': 'batch-1' }]
const BATCH_BACKLOG_RESP = [{ barcode: 'EA123456789RU' }]

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
      arrayBuffer: async () => new ArrayBuffer(8),
    }
  })
}

const order = {
  orderId: 'ORD-001',
  status: 'paid' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  platform: 'telegram' as const,
  customerChatId: '12345',
  orderData: {
    items: [
      { slug: 'ring-silver', title: 'Кольцо серебро', price: 5000, quantity: 1 },
      { slug: 'earrings-gold', title: 'Серьги золото', price: 3000, quantity: 2 },
    ],
    fullName: 'Иванов Иван',
    phone: '+79001234567',
    country: 'Германия',
    city: 'Berlin',
    address: '10115, Berlin, Strasse 1',
    deliveryRegion: '',
    deliveryCost: 600,
    total: 11600,
    deliveryMethod: 'ems' as const,
    recipientCountry: 'Германия',
    recipientCountryCode: 276,
    recipientCity: 'Berlin',
    recipientStreet: 'Strasse 1',
    recipientIndex: '10115',
  },
}

beforeEach(async () => {
  pochta = await import('./pochta.js')
  pochta._resetAuthCache()
  pochta._resetCountriesCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getCountries', () => {
  const DICT_RESP = {
    country: [
      { id: 276, name: 'ГЕРМАНИЯ' },
      { id: 840, name: 'СОЕДИНЕННЫЕ ШТАТЫ' },
      { id: 1, name: '' }, // без имени — отфильтровывается
    ],
  }

  it('maps id→code, title-cases name, sorts and filters', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: DICT_RESP }]))
    const list = await pochta.getCountries()
    expect(list).toEqual([
      { code: 276, name: 'Германия' },
      { code: 840, name: 'Соединенные Штаты' },
    ])
  })

  it('caches result (no second fetch)', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: DICT_RESP }]))
    await pochta.getCountries()
    await pochta.getCountries()
    expect((fetch as any).mock.calls).toHaveLength(1)
  })

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: false, body: {} }]))
    await expect(pochta.getCountries()).rejects.toThrow('HTTP 400')
  })

  it('throws on empty dictionary', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { country: [] } }]))
    await expect(pochta.getCountries()).rejects.toThrow('пустой справочник')
  })
})

describe('checkRequiredPochtaEnv', () => {
  it('returns true when all required env set', () => {
    expect(pochta.checkRequiredPochtaEnv()).toBe(true)
  })

  it('returns false when a required env is missing', () => {
    const orig = process.env.POCHTA_INDEX_FROM
    delete process.env.POCHTA_INDEX_FROM
    expect(pochta.checkRequiredPochtaEnv()).toBe(false)
    process.env.POCHTA_INDEX_FROM = orig
  })
})

describe('auth headers', () => {
  it('sends AccessToken and Basic X-User-Authorization', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: TARIFF_RESP }]))
    await pochta.calculateTariff(276)
    const calls = (fetch as any).mock.calls as [string, RequestInit][]
    const headers = calls[0][1].headers as Record<string, string>
    expect(headers.Authorization).toBe('AccessToken access-token-123')
    const expectedBasic = Buffer.from('login@example.com:secret').toString('base64')
    expect(headers['X-User-Authorization']).toBe(`Basic ${expectedBasic}`)
  })

  it('throws when token missing', async () => {
    const orig = process.env.POCHTA_TOKEN
    delete process.env.POCHTA_TOKEN
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: TARIFF_RESP }]))
    await expect(pochta.calculateTariff(276)).rejects.toThrow('POCHTA_TOKEN')
    process.env.POCHTA_TOKEN = orig
  })
})

describe('calculateTariff', () => {
  it('returns (rate + vat) in rubles, ceiled', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: TARIFF_RESP }]))
    const cost = await pochta.calculateTariff(276)
    expect(cost).toBe(600)
  })

  it('ceils fractional kopecks', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { 'total-rate': 50050, 'total-vat': 0 } }]))
    const cost = await pochta.calculateTariff(276)
    expect(cost).toBe(501) // 50050/100 = 500.5 → 501
  })

  it('sends mail-direct and mass', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: TARIFF_RESP }]))
    await pochta.calculateTariff(276)
    const calls = (fetch as any).mock.calls as [string, RequestInit][]
    const body = JSON.parse(calls[0][1].body as string)
    expect(body['mail-direct']).toBe(276)
    expect(body['index-from']).toBe('121471')
    expect(body.mass).toBe(200)
  })

  it('throws when total-rate missing', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { errors: ['bad country'] } }]))
    await expect(pochta.calculateTariff(276)).rejects.toThrow('no total-rate')
  })

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: false, body: { error: 'unauthorized' } }]))
    await expect(pochta.calculateTariff(276)).rejects.toThrow('HTTP 400')
  })
})

describe('createPochtaOrder', () => {
  it('returns id from result-ids', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: ORDER_RESP }]))
    const result = await pochta.createPochtaOrder(order)
    expect(result.id).toBe(777)
  })

  it('builds customs declaration from items', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: ORDER_RESP }]))
    await pochta.createPochtaOrder(order)
    const calls = (fetch as any).mock.calls as [string, RequestInit][]
    const body = JSON.parse(calls[0][1].body as string)
    const decl = body[0]['customs-declaration']
    expect(decl['customs-entries']).toHaveLength(2)
    expect(decl['customs-entries'][0]).toMatchObject({
      description: 'Jewellery', // латиница для таможни (по умолчанию)
      amount: 1,
      value: 500000, // 5000 ₽ в копейках
      'country-code': 643,
    })
    expect(decl['customs-entries'][0]['tnved-code']).toBeTruthy()
    expect(decl['entries-type']).toBe('SALE_OF_GOODS')
  })

  it('sends recipient country code and address', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: ORDER_RESP }]))
    await pochta.createPochtaOrder(order)
    const calls = (fetch as any).mock.calls as [string, RequestInit][]
    const body = JSON.parse(calls[0][1].body as string)[0]
    expect(body['mail-direct']).toBe(276)
    expect(body['country-code']).toBe(276)
    expect(body['place-to']).toBe('Berlin')
    expect(body['str-index-to']).toBe('10115')
    expect(calls[0][1].method).toBe('PUT')
  })

  it('throws when result-id missing', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { errors: ['address invalid'] } }]))
    await expect(pochta.createPochtaOrder(order)).rejects.toThrow('no result-id')
  })

  it('throws when recipientCountryCode missing', async () => {
    const badOrder = { ...order, orderData: { ...order.orderData, recipientCountryCode: undefined } }
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: ORDER_RESP }]))
    await expect(pochta.createPochtaOrder(badOrder as any)).rejects.toThrow('recipientCountryCode')
  })
})

describe('createBatch', () => {
  it('returns batch-name', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: BATCH_RESP }]))
    const batch = await pochta.createBatch([777])
    expect(batch).toBe('batch-1')
  })

  it('throws when batch-name missing', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: [{}] }]))
    await expect(pochta.createBatch([777])).rejects.toThrow('no batch-name')
  })
})

describe('getShpiFromBatch', () => {
  it('returns barcode (ШПИ) of first order', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: BATCH_BACKLOG_RESP }]))
    const shpi = await pochta.getShpiFromBatch('batch-1')
    expect(shpi).toBe('EA123456789RU')
  })

  it('returns null when no barcode yet', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: [{}] }]))
    const shpi = await pochta.getShpiFromBatch('batch-1')
    expect(shpi).toBeNull()
  })
})
