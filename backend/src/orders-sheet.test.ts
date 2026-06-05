import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('dotenv/config', () => ({}))

// vi.mock factory вызывается до инициализации переменных — используем vi.hoisted()
const { sheetGetMock, valuesGetMock, valuesUpdateMock, valuesAppendMock } = vi.hoisted(() => ({
  sheetGetMock: vi.fn(),
  valuesGetMock: vi.fn(),
  valuesUpdateMock: vi.fn().mockResolvedValue({}),
  valuesAppendMock: vi.fn().mockResolvedValue({}),
}))

vi.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: vi.fn().mockImplementation(() => ({})),
    },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        get: sheetGetMock,
        values: {
          get: valuesGetMock,
          update: valuesUpdateMock,
          append: valuesAppendMock,
        },
        batchUpdate: vi.fn().mockResolvedValue({}),
      },
    }),
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
}))

vi.mock('./store.js', () => ({
  listProducts: vi.fn().mockReturnValue([]),
}))

import { getOrderFromSheet } from './orders-sheet.js'

const ORDER_ID = 'ORD-1717000000000'

const ORDER_ROW = [
  ORDER_ID,
  '2024-01-01T10:00:00.000Z',
  '2024-01-01T10:05:00.000Z',
  'pending',
  'telegram',
  '123456789',
  'Иван Иванов',
  'Иванов Иван Иванович',
  '+79001234567',
  'ivan_ivanov',
  'Россия',
  'Москва',
  'ул. Ленина, 1',
  'russia',
  '500',
  '2000',
  '',
  '0',
  'false',
  '0',
  '2500',
  'Комментарий',
  '',
]

const ITEM_ROW = [
  ORDER_ID,
  'ring-gold-01',
  'Кольцо золото',
  '2000',
  '1',
  'ART-001',
  'rings',
]

describe('getOrderFromSheet', () => {
  beforeEach(() => {
    sheetGetMock.mockReset()
    valuesGetMock.mockReset()

    process.env.IMPORT_SHEET_ID = 'sheet123'
    process.env.GOOGLE_SA_JSON = JSON.stringify({
      client_email: 'test@test.iam.gserviceaccount.com',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
    })
  })

  afterEach(() => {
    delete process.env.IMPORT_SHEET_ID
    delete process.env.GOOGLE_SA_JSON
  })

  it('возвращает null если строка заказа не найдена', async () => {
    valuesGetMock.mockResolvedValueOnce({ data: { values: [['headers'], ['OTHER-999']] } })

    const result = await getOrderFromSheet('ORD-9999')
    expect(result).toBeNull()
  })

  it('маппит все поля заказа корректно', async () => {
    valuesGetMock
      .mockResolvedValueOnce({ data: { values: [['headers'], ORDER_ROW] } })
      .mockResolvedValueOnce({ data: { values: [['headers'], ITEM_ROW] } })

    const order = await getOrderFromSheet(ORDER_ID)

    expect(order).not.toBeNull()
    expect(order!.orderId).toBe(ORDER_ID)
    expect(order!.sheetStatus).toBe('pending')
    expect(order!.platform).toBe('telegram')
    expect(order!.customerChatId).toBe('123456789')
    expect(order!.orderData.fullName).toBe('Иванов Иван Иванович')
    expect(order!.orderData.phone).toBe('+79001234567')
    expect(order!.orderData.total).toBe(2500)
    expect(order!.orderData.deliveryCost).toBe(500)
    expect(order!.orderData.items).toHaveLength(1)
    expect(order!.orderData.items[0].slug).toBe('ring-gold-01')
    expect(order!.orderData.items[0].price).toBe(2000)
    expect(order!.orderData.items[0].quantity).toBe(1)
    expect(order!.orderData.items[0].article).toBe('ART-001')
  })

  it('возвращает null при ошибке googleapis', async () => {
    valuesGetMock.mockRejectedValueOnce(new Error('googleapis network error'))

    const result = await getOrderFromSheet(ORDER_ID)
    expect(result).toBeNull()
  })

  it('возвращает null если IMPORT_SHEET_ID не задан', async () => {
    delete process.env.IMPORT_SHEET_ID

    const result = await getOrderFromSheet(ORDER_ID)
    expect(result).toBeNull()
  })
})
