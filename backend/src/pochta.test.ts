import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Set env before module import
process.env.POCHTA_API_BASE = 'https://otpravka-api.pochta.ru'
process.env.POCHTA_TOKEN = 'access-token-123'
process.env.POCHTA_LOGIN = 'login@example.com'
process.env.POCHTA_PASSWORD = 'secret'
process.env.POCHTA_INDEX_FROM = '121471'

// vi.fn(impl), а не vi.fn().mockResolvedValue(): restoreAllMocks в afterEach возвращает
// реализацию к impl, и sendAlert(...).catch() в коде продолжает получать промис
const sendAlert = vi.fn(async (..._a: any[]) => {})
vi.mock('./alerts.js', () => ({ sendAlert: (...a: any[]) => sendAlert(...a) }))

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

  it('HTTP error carries status (lets callers tell an auth failure from an outage)', async () => {
    vi.stubGlobal('fetch', failingFetch(401, '{"code":"1001","desc":"ILLEGAL_CREDENTIALS"}'))
    const err = await pochta.calculateTariff(860).catch(e => e)
    expect(err.status).toBe(401)
    expect(err.message).toContain('HTTP 401')
  })
})

function failingFetch(status: number, body: string) {
  return vi.fn(async () => ({ ok: false, status, text: async () => body, json: async () => ({}) }))
}

// инцидент 02.11.2026: старый пароль на Render → 401 на каждый расчёт, ни одного алерта
describe('alertTariffFailure', () => {
  beforeEach(() => sendAlert.mockClear())

  it('401 (stale password on Render) → critical POCHTA_TARIFF_CONFIG', async () => {
    vi.stubGlobal('fetch', failingFetch(401, '{"code":"1001","desc":"ILLEGAL_CREDENTIALS"}'))
    const err = await pochta.calculateTariff(860).catch(e => e)
    pochta.alertTariffFailure(err, 860)
    expect(sendAlert).toHaveBeenCalledTimes(1)
    const [text, opts] = sendAlert.mock.calls[0]
    expect(opts).toMatchObject({ tag: 'pochta', level: 'critical', code: 'POCHTA_TARIFF_CONFIG' })
    expect(text).toContain('ILLEGAL_CREDENTIALS')
    expect(text).toContain('860')
  })

  it('missing env → critical POCHTA_TARIFF_CONFIG', async () => {
    const orig = process.env.POCHTA_INDEX_FROM
    delete process.env.POCHTA_INDEX_FROM
    try {
      const err = await pochta.calculateTariff(860).catch(e => e)
      pochta.alertTariffFailure(err, 860)
    } finally {
      process.env.POCHTA_INDEX_FROM = orig
    }
    expect(sendAlert.mock.calls[0][1]).toMatchObject({ level: 'critical', code: 'POCHTA_TARIFF_CONFIG' })
  })

  it('network failure or Pochta 5xx → high POCHTA_TARIFF_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    pochta.alertTariffFailure(await pochta.calculateTariff(860).catch(e => e), 860)
    vi.stubGlobal('fetch', failingFetch(503, 'Service Unavailable'))
    pochta.alertTariffFailure(await pochta.calculateTariff(860).catch(e => e), 860)
    expect(sendAlert.mock.calls.map(c => c[1])).toEqual([
      expect.objectContaining({ level: 'high', code: 'POCHTA_TARIFF_FAILED' }),
      expect.objectContaining({ level: 'high', code: 'POCHTA_TARIFF_FAILED' }),
    ])
  })

  it('same failure across countries collapses in dedup (first 150 chars match)', async () => {
    vi.stubGlobal('fetch', failingFetch(401, '{"code":"1001","desc":"ILLEGAL_CREDENTIALS"}'))
    const err = await pochta.calculateTariff(860).catch(e => e)
    pochta.alertTariffFailure(err, 860)
    pochta.alertTariffFailure(err, 276)
    const [a, b] = sendAlert.mock.calls.map(c => c[0] as string)
    expect(a).not.toBe(b)
    expect(a.slice(0, 150)).toBe(b.slice(0, 150))
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
      description: 'Clay jewerly', // латиница, как у заказчика при ручном оформлении (по умолчанию)
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

  it('sends dimension for EMS, omits for SMALL_PACKET (DIMENSION_NOT_SUPPORTED)', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: ORDER_RESP }]))
    await pochta.createPochtaOrder(order) // дефолт EMS
    let body = JSON.parse(((fetch as any).mock.calls as [string, RequestInit][])[0][1].body as string)[0]
    expect(body.dimension).toBeDefined()

    process.env.POCHTA_MAIL_TYPE = 'SMALL_PACKET'
    process.env.POCHTA_MAIL_CATEGORY = 'ORDERED'
    try {
      vi.stubGlobal('fetch', mockFetch([{ ok: true, body: ORDER_RESP }]))
      await pochta.createPochtaOrder(order)
      body = JSON.parse(((fetch as any).mock.calls as [string, RequestInit][])[0][1].body as string)[0]
      expect(body.dimension).toBeUndefined()
      expect(body['mail-type']).toBe('SMALL_PACKET')
      expect(body['mail-category']).toBe('ORDERED')
    } finally {
      delete process.env.POCHTA_MAIL_TYPE
      delete process.env.POCHTA_MAIL_CATEGORY
    }
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

  // Классическая схема (оплата при сдаче) на аккаунте выключена — без этого признака
  // Почта отказывает по всей партии. См. комментарий в createBatch.
  it('requests the online-balance payment scheme', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: BATCH_RESP }]))
    await pochta.createBatch([777])
    const calls = (fetch as any).mock.calls as [string, RequestInit][]
    expect(calls[0][0]).toContain('use-online-balance=true')
  })

  // дата сдачи печатается на документах; без параметра Почта ставит день создания партии
  it('passes the sending date in kebab-case when given', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { batches: [{ 'batch-name': '24' }] } }]))
    const batch = await pochta.createBatch([777], '2026-11-05')
    expect(batch).toBe('24')
    const url = ((fetch as any).mock.calls as [string, RequestInit][])[0][0]
    expect(url).toContain('sending-date=2026-11-05')
    expect(url).toContain('use-online-balance=true')
  })

  it('omits the sending date when not given', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: BATCH_RESP }]))
    await pochta.createBatch([777])
    expect(((fetch as any).mock.calls as [string, RequestInit][])[0][0]).not.toContain('sending-date')
  })

  // отказ приходит HTTP 200 со списком errors — код нужен админке (просроченная дата и т.п.)
  it('carries the Pochta error code when the batch is refused', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { batches: [], errors: [{ 'error-code': 'PAST_DUE_DATE' }] } }]))
    await expect(pochta.createBatch([777], '2026-01-01')).rejects.toMatchObject({ code: 'PAST_DUE_DATE' })
  })
})

describe('getBatch', () => {
  it('maps status, list number and sending date', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: {
      'batch-name': '24', 'batch-status': 'CREATED', 'batch-status-date': '2026-11-04T10:00:00Z',
      'list-number': 5, 'list-number-date': '2026-11-05',
    } }]))
    expect(await pochta.getBatch('24')).toEqual({
      name: '24', status: 'CREATED', statusDate: '2026-11-04T10:00:00Z', listNumber: 5, sendingDate: '2026-11-05',
    })
    expect(((fetch as any).mock.calls as [string, RequestInit][])[0][0]).toContain('/1.0/batch/24')
  })

  // номер ф.103 — признак пройденного checkin; у несданной партии его нет, а дата есть
  // (так выглядит боевая партия 23 на 04.11.2026)
  it('no list number before checkin', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { 'batch-name': '23', 'batch-status': 'CREATED', 'list-number-date': '2026-08-08' } }]))
    const info = await pochta.getBatch('23')
    expect(info.listNumber).toBeNull()
    expect(info.sendingDate).toBe('2026-08-08')
  })
})

describe('setBatchSendingDate', () => {
  it('posts year/month/day path segments', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { 'f103-sent': true } }]))
    const res = await pochta.setBatchSendingDate('24', '2026-11-05')
    expect(res).toEqual({ f103Sent: true, errorCode: null })
    const [url, init] = ((fetch as any).mock.calls as [string, RequestInit][])[0]
    expect(url).toContain('/1.0/batch/24/sending/2026/11/5')
    expect(init.method).toBe('POST')
  })
})

describe('findShipmentByOrderNum / findBacklogOrderByOrderNum', () => {
  it('finds the shipment by exact order number', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: [
      { id: 1, 'order-num': 'ORD-1', barcode: 'X', 'batch-name': '1' },
      { id: 2340000001, 'order-num': 'ORD-1786000000001', barcode: 'LS000000094RU', 'batch-name': '23', 'batch-status': 'CREATED' },
    ] }]))
    const s = await pochta.findShipmentByOrderNum('ORD-1786000000001')
    expect(s).toMatchObject({ id: 2340000001, barcode: 'LS000000094RU', batchName: '23', batchStatus: 'CREATED' })
    expect(((fetch as any).mock.calls as [string, RequestInit][])[0][0]).toContain('/1.0/shipment/search?query=ORD-1786000000001')
  })

  it('null when nothing matches exactly', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: [{ id: 1, 'order-num': 'ORD-17', 'batch-name': '1' }] }]))
    expect(await pochta.findShipmentByOrderNum('ORD-1')).toBeNull()
  })

  it('finds a backlog order id by order number', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: [{ id: 555, 'order-num': 'ORD-9' }] }]))
    expect(await pochta.findBacklogOrderByOrderNum('ORD-9')).toBe(555)
    expect(((fetch as any).mock.calls as [string, RequestInit][])[0][0]).toContain('/1.0/backlog/search?query=ORD-9')
  })

  it('backlog: null when absent', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: [] }]))
    expect(await pochta.findBacklogOrderByOrderNum('ORD-9')).toBeNull()
  })
})

describe('checkinBatch', () => {
  it('reports success when f103 was sent', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { 'f103-sent': true } }]))
    const res = await pochta.checkinBatch('batch-1')
    expect(res).toEqual({ f103Sent: true, errorCode: null })
  })

  // Почта отвечает HTTP 200 и при отказе — судить об успехе можно ТОЛЬКО по f103-sent
  it('reports failure with error code on HTTP 200', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { ok: true, body: { 'error-code': 'NOT_ENOUGH_FUNDS', 'f103-sent': false } },
    ]))
    const res = await pochta.checkinBatch('batch-1')
    expect(res).toEqual({ f103Sent: false, errorCode: 'NOT_ENOUGH_FUNDS' })
  })

  it('posts to the batch checkin endpoint', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { 'f103-sent': true } }]))
    await pochta.checkinBatch('batch-1')
    const calls = (fetch as any).mock.calls as [string, RequestInit][]
    expect(calls[0][0]).toContain('/1.0/batch/batch-1/checkin')
    expect(calls[0][1].method).toBe('POST')
  })

  // Регрессия: у checkin параметр называется useOnlineBalance (camelCase), а не
  // use-online-balance, как у создания партии. Чужое имя Почта молча игнорирует и
  // отвечает OFFLINE_BALANCE_FORBIDDEN — на этом застряли с 15.09 по 02.11.2026.
  it('pays from the online balance using the camelCase flag', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: { 'f103-sent': true } }]))
    await pochta.checkinBatch('batch-1')
    const url = ((fetch as any).mock.calls as [string, RequestInit][])[0][0]
    expect(url).toContain('useOnlineBalance=true')
    expect(url).not.toContain('use-online-balance')
  })
})

describe('downloadF103', () => {
  // Регрессия: путь БЕЗ сегмента "batch". Неверный /1.0/forms/batch/{n}/f103pdf
  // не существует, но отдаёт ложный 403 UNAUTHORIZED вместо 404 — на этом потеряли
  // полтора месяца переписки с техподдержкой.
  it('uses /1.0/forms/{batch}/f103pdf without the batch segment', async () => {
    vi.stubGlobal('fetch', mockFetch([{ ok: true, body: {} }]))
    await pochta.downloadF103('batch-1')
    const url = String(((fetch as any).mock.calls as [string, RequestInit][])[0][0])
    expect(url).toContain('/1.0/forms/batch-1/f103pdf')
    expect(url).not.toContain('/forms/batch/')
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
