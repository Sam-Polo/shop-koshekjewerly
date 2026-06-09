import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('dotenv/config', () => ({}))

vi.mock('./sheets.js', () => ({ fetchProductsFromSheet: vi.fn().mockResolvedValue([]) }))
vi.mock('./store.js', () => ({
  listProducts: vi.fn().mockReturnValue([]),
  upsertProducts: vi.fn(),
  decreaseProductStock: vi.fn().mockReturnValue(true),
}))
vi.mock('./orders.js', () => ({
  createOrder: vi.fn(),
  getOrder: vi.fn(),
  updateOrderStatus: vi.fn().mockReturnValue({ orderId: 'ORD-1', status: 'paid', updatedAt: Date.now() }),
  listOrders: vi.fn().mockReturnValue([]),
}))
vi.mock('./orders-sheet.js', () => ({
  appendOrderToSheet: vi.fn().mockResolvedValue(undefined),
  updateOrderStatusInSheet: vi.fn().mockResolvedValue(undefined),
  ensureOrderSheets: vi.fn().mockResolvedValue(undefined),
  getOrderFromSheet: vi.fn(),
}))
vi.mock('./robokassa.js', () => ({
  generatePaymentUrl: vi.fn().mockReturnValue('https://pay.test'),
  verifyResultSignature: vi.fn().mockReturnValue(true),
  queryOrderState: vi.fn(),
  IS_TEST: true,
  MERCHANT_LOGIN: 'test',
}))
vi.mock('./settings.js', () => ({ fetchOrdersSettingsFromSheet: vi.fn().mockResolvedValue({ ordersClosed: false }) }))
vi.mock('./categories.js', () => ({ fetchCategoriesFromSheet: vi.fn().mockResolvedValue([]) }))
vi.mock('./constructor.js', () => ({
  fetchBasesFromSheet: vi.fn().mockResolvedValue([]),
  fetchPendantsFromSheet: vi.fn().mockResolvedValue([]),
  setCachedBases: vi.fn(),
  setCachedPendants: vi.fn(),
  getCachedBases: vi.fn().mockReturnValue([]),
  getCachedPendants: vi.fn().mockReturnValue([]),
  basesForType: vi.fn().mockReturnValue([]),
  pendantsForType: vi.fn().mockReturnValue([]),
  effectiveLimit: vi.fn().mockReturnValue(1),
  JEWELRY_TYPES: [],
}))
vi.mock('./promocodes.js', () => ({
  fetchPromocodesFromSheet: vi.fn().mockResolvedValue([]),
  loadPromocodes: vi.fn(),
  findPromocode: vi.fn(),
  validatePromocode: vi.fn(),
  listPromocodes: vi.fn().mockReturnValue([]),
}))
vi.mock('./alerts.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }))

const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
vi.stubGlobal('fetch', fetchMock)

import type { Order } from './orders.js'

const NOW = Date.now()
const ELEVEN_MIN_AGO = NOW - 11 * 60 * 1000

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: 'ORD-1717000000000',
    status: 'pending',
    createdAt: ELEVEN_MIN_AGO,
    updatedAt: ELEVEN_MIN_AGO,
    customerChatId: '123456789',
    customerName: 'Иван',
    platform: 'telegram',
    orderData: {
      items: [{ slug: 'ring-01', title: 'Кольцо', price: 2000, quantity: 1 }],
      fullName: 'Иванов Иван',
      phone: '+79001234567',
      country: 'Россия',
      city: 'Москва',
      address: 'ул. Ленина, 1',
      deliveryRegion: 'russia',
      deliveryCost: 500,
      total: 2500,
    },
    ...overrides,
  }
}

describe('checkPendingOrders', () => {
  let checkPendingOrders: Awaited<typeof import('./server.js')>['checkPendingOrders']
  let listOrders: ReturnType<typeof vi.fn>
  let queryOrderState: ReturnType<typeof vi.fn>
  let updateOrderStatus: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    vi.mock('./orders.js', () => ({
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      updateOrderStatus: vi.fn().mockReturnValue({ orderId: 'ORD-1717000000000', status: 'paid', updatedAt: Date.now() }),
      listOrders: vi.fn().mockReturnValue([]),
    }))
    vi.mock('./robokassa.js', () => ({
      generatePaymentUrl: vi.fn().mockReturnValue('https://pay.test'),
      verifyResultSignature: vi.fn().mockReturnValue(true),
      queryOrderState: vi.fn(),
      IS_TEST: true,
      MERCHANT_LOGIN: 'test',
    }))
    vi.mock('./alerts.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }))

    process.env.TG_BOT_TOKEN = 'test-token'
    process.env.TG_MANAGER_CHAT_ID = '111111'
    process.env.IMPORT_SHEET_ID = 'sheet123'
    process.env.ROBOKASSA_MERCHANT_LOGIN = 'merchant'
    process.env.ROBOKASSA_PASSWORD_1 = 'pass1'
    process.env.ROBOKASSA_PASSWORD_2 = 'pass2'

    const serverModule = await import('./server.js')
    checkPendingOrders = serverModule.checkPendingOrders

    const ordersModule = await import('./orders.js')
    listOrders = ordersModule.listOrders as ReturnType<typeof vi.fn>
    updateOrderStatus = ordersModule.updateOrderStatus as ReturnType<typeof vi.fn>

    const robokassaModule = await import('./robokassa.js')
    queryOrderState = robokassaModule.queryOrderState as ReturnType<typeof vi.fn>

    // сбрасываем счётчики вызовов и настройки возврата:
    // vi.mock() в beforeEach не hoisted — vitest переиспользует тот же vi.fn() инстанс
    listOrders.mockReset()
    listOrders.mockReturnValue([])
    updateOrderStatus.mockReset()
    updateOrderStatus.mockReturnValue({ orderId: 'ORD-1717000000000', status: 'paid', updatedAt: Date.now() })
    queryOrderState.mockReset()
  })

  afterEach(() => {
    delete process.env.TG_BOT_TOKEN
    delete process.env.TG_MANAGER_CHAT_ID
    delete process.env.FEATURE_PAYMENT_POLLING
  })

  it('ничего не делает если нет pending-заказов', async () => {
    listOrders.mockReturnValue([])

    await checkPendingOrders()

    expect(queryOrderState).not.toHaveBeenCalled()
  })

  it('пропускает слишком свежий заказ (< 10 мин)', async () => {
    const freshOrder = makeOrder({ createdAt: Date.now() - 5 * 60_000 }) // 5 минут
    listOrders.mockReturnValue([freshOrder])

    await checkPendingOrders()

    expect(queryOrderState).not.toHaveBeenCalled()
  })

  it('пропускает заказ со статусом не pending', async () => {
    const paidOrder = makeOrder({ status: 'paid' })
    listOrders.mockReturnValue([paidOrder])

    await checkPendingOrders()

    expect(queryOrderState).not.toHaveBeenCalled()
  })

  it('не обрабатывает если stateCode не 100 (например, 5 = ещё не оплачен)', async () => {
    listOrders.mockReturnValue([makeOrder()])
    queryOrderState.mockResolvedValue({ stateCode: 5, outSum: '2500.00' })

    await checkPendingOrders()

    expect(updateOrderStatus).not.toHaveBeenCalled()
  })

  it('не обрабатывает если stateCode = 0 (pending)', async () => {
    listOrders.mockReturnValue([makeOrder()])
    queryOrderState.mockResolvedValue({ stateCode: 0, outSum: '2500.00' })

    await checkPendingOrders()

    expect(updateOrderStatus).not.toHaveBeenCalled()
  })

  it('обрабатывает pending-заказ когда stateCode = 100 (оплачено)', async () => {
    listOrders.mockReturnValue([makeOrder()])
    queryOrderState.mockResolvedValue({ stateCode: 100, outSum: '2500.00' })

    await checkPendingOrders()

    expect(queryOrderState).toHaveBeenCalledWith('1717000000000')
    expect(updateOrderStatus).toHaveBeenCalledWith('ORD-1717000000000', 'paid')
  })

  it('не падает если queryOrderState вернул null', async () => {
    listOrders.mockReturnValue([makeOrder()])
    queryOrderState.mockResolvedValue(null)

    await expect(checkPendingOrders()).resolves.not.toThrow()
    expect(updateOrderStatus).not.toHaveBeenCalled()
  })

  it('выключается через FEATURE_PAYMENT_POLLING=false', async () => {
    process.env.FEATURE_PAYMENT_POLLING = 'false'
    listOrders.mockReturnValue([makeOrder()])

    await checkPendingOrders()

    expect(queryOrderState).not.toHaveBeenCalled()
  })
})
