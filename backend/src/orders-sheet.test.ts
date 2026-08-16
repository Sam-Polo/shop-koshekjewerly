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

import { getOrderFromSheet, isOrderShipped, statusRank, labelForDelivery } from './orders-sheet.js'
import { customerStatusForStage } from './amocrm-lead-processor.js'

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

// Статус «отправлен» в ЛК выводится только из того, что уже лежит в Sheets — к СДЭКу
// за ним не ходим. Проверить это на реальных данных нельзя (в команде нет покупателей,
// которые действительно получают заказы), поэтому правило закрыто тестом целиком.
describe('isOrderShipped', () => {
  it('отправлен: есть cdek-трек и флаг shipped_notified', () => {
    expect(isOrderShipped('cdek', '1234567890', 'shipped_notified')).toBe(true)
  })

  it('не отправлен: трек есть, флага нет (заказ создан, но не уехал)', () => {
    expect(isOrderShipped('cdek', '1234567890', '')).toBe(false)
  })

  it('не отправлен: флаг есть, но трека нет', () => {
    expect(isOrderShipped('cdek', '', 'shipped_notified')).toBe(false)
  })

  it('EMS: всегда false, даже с треком и флагом', () => {
    expect(isOrderShipped('ems', '1234567890', 'shipped_notified')).toBe(false)
  })

  it('старый заказ с пустым delivery_method считается СДЭКом, если есть трек', () => {
    expect(isOrderShipped('', '1234567890', 'shipped_notified')).toBe(true)
  })

  it('находит флаг среди других заметок менеджера', () => {
    const note = 'позвонить покупателю\nshipped_notified\ntrack: https://cdek.ru/m/order/123'
    expect(isOrderShipped('cdek', '1234567890', note)).toBe(true)
  })

  it('самовывоз и электронный сертификат: трека нет, значит не отправлен', () => {
    expect(isOrderShipped('pickup', '', 'shipped_notified')).toBe(false)
    expect(isOrderShipped('digital', '', '')).toBe(false)
  })
})

// Статус заказа в ЛК собирается из двух независимых источников (этапы amoCRM и
// вебхук СДЭКа), которые приходят в произвольном порядке. Правила движения статуса
// закрыты тестами целиком: проверить их на реальных заказах нечем — в команде нет
// людей, которые действительно получают посылки.
describe('статусы заказа для ЛК', () => {
  it('порядок статусов задаёт движение заказа', () => {
    expect(statusRank('Принят')).toBeLessThan(statusRank('В сборке'))
    expect(statusRank('В сборке')).toBeLessThan(statusRank('В пути'))
    expect(statusRank('В пути')).toBeLessThan(statusRank('Уже у вас'))
  })

  it('«Отправлен» (EMS) стоит на одной ступени с «В пути» — метки не перебивают друг друга', () => {
    expect(statusRank('Отправлен')).toBe(statusRank('В пути'))
    expect(statusRank('В сборке')).toBeLessThan(statusRank('Отправлен'))
    expect(statusRank('Отправлен')).toBeLessThan(statusRank('Уже у вас'))
  })

  it('EMS: «В пути» показывается как «Отправлен», остальные статусы не трогаются', () => {
    expect(labelForDelivery('В пути', 'ems')).toBe('Отправлен')
    expect(labelForDelivery('Принят', 'ems')).toBe('Принят')
    expect(labelForDelivery('В сборке', 'ems')).toBe('В сборке')
  })

  it('СДЭК и самовывоз оставляют «В пути» как есть', () => {
    expect(labelForDelivery('В пути', 'cdek')).toBe('В пути')
    expect(labelForDelivery('В пути', 'pickup')).toBe('В пути')
    expect(labelForDelivery('В пути', '')).toBe('В пути')
  })

  it('неизвестный или пустой статус — ранг -1, любой реальный статус его обгоняет', () => {
    expect(statusRank('')).toBe(-1)
    expect(statusRank('какая-то ерунда')).toBe(-1)
    expect(statusRank('Принят')).toBeGreaterThan(statusRank(''))
  })

  it('этапы «до отправки» дают Принят', () => {
    expect(customerStatusForStage(86423882)).toBe('Принят') // Неразобранное
    expect(customerStatusForStage(86486222)).toBe('Принят') // ПРИОРИТЕТНЫЙ ЗАКАЗ
    expect(customerStatusForStage(86423886)).toBe('Принят') // НОВЫЙ, ЖДЕТ ОТПРАВКИ
    expect(customerStatusForStage(86584502)).toBe('Принят') // САМОВЫВОЗ
  })

  it('«В работе» и «Собран» дают В сборке', () => {
    expect(customerStatusForStage(86486582)).toBe('В сборке')
    expect(customerStatusForStage(86486586)).toBe('В сборке')
  })

  it('«Отправлен» и «Завершён» дают В пути', () => {
    expect(customerStatusForStage(86462242)).toBe('В пути')
    expect(customerStatusForStage(142)).toBe('В пути')
  })

  it('CRM никогда не выдаёт «Уже у вас» — доставку подтверждает только СДЭК', () => {
    const fromCrm = [86423882, 86486222, 86423886, 86584502, 86486582, 86486586, 86462242, 142]
      .map(customerStatusForStage)
    expect(fromCrm).not.toContain('Уже у вас')
  })

  it('возврат и закрытие статус не меняют', () => {
    expect(customerStatusForStage(86423894)).toBeNull() // ВОЗВРАЩЕН
    expect(customerStatusForStage(143)).toBeNull()      // Закрыто
    expect(customerStatusForStage(999999)).toBeNull()   // чужой этап
  })

  it('откат этапа в CRM не отматывает статус назад', () => {
    // менеджер вернул сделку из «Отправлен» в «В работе» уже после доставки
    const current = 'Уже у вас'
    const fromCrm = customerStatusForStage(86486582)! // В сборке
    expect(statusRank(fromCrm)).toBeLessThan(statusRank(current))
  })
})

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
