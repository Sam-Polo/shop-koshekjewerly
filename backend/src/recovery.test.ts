import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('dotenv/config', () => ({}))

// мокируем все внешние зависимости server.ts
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
  buildPaymentForm: vi.fn().mockReturnValue({ actionUrl: 'https://pay.test', fields: {} }),
  buildReceipt: vi.fn().mockReturnValue(null),
  verifyResultSignature: vi.fn().mockReturnValue(true),
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

// мокируем отправку TG/MAX сообщений (они внутри server.ts, не экспортируются)
const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' })
vi.stubGlobal('fetch', fetchMock)

import type { Order } from './orders.js'

function makeOrder(status: Order['status'] = 'pending'): Order {
  return {
    orderId: 'ORD-1717000000000',
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    customerChatId: '123456789',
    customerName: 'Иван',
    platform: 'telegram',
    orderData: {
      items: [{ slug: 'ring-01', title: 'Кольцо', price: 2000, quantity: 1, article: 'A01' }],
      fullName: 'Иванов Иван',
      phone: '+79001234567',
      country: 'Россия',
      city: 'Москва',
      address: 'ул. Ленина, 1',
      deliveryRegion: 'russia',
      deliveryCost: 500,
      total: 2500,
    },
  }
}

describe('processPaidOrder', () => {
  let processPaidOrder: Awaited<typeof import('./server.js')>['processPaidOrder']
  let updateOrderStatusInSheet: ReturnType<typeof vi.fn>
  let updateOrderStatus: ReturnType<typeof vi.fn>
  let decreaseProductStock: ReturnType<typeof vi.fn>
  let sendAlert: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    // переустанавливаем моки после resetModules
    vi.mock('./orders.js', () => ({
      createOrder: vi.fn(),
      getOrder: vi.fn(),
      updateOrderStatus: vi.fn().mockReturnValue({ orderId: 'ORD-1717000000000', status: 'paid', updatedAt: Date.now() }),
      listOrders: vi.fn().mockReturnValue([]),
    }))
    vi.mock('./orders-sheet.js', () => ({
      appendOrderToSheet: vi.fn().mockResolvedValue(undefined),
      updateOrderStatusInSheet: vi.fn().mockResolvedValue(undefined),
      ensureOrderSheets: vi.fn().mockResolvedValue(undefined),
      getOrderFromSheet: vi.fn(),
    }))
    vi.mock('./store.js', () => ({
      listProducts: vi.fn().mockReturnValue([]),
      upsertProducts: vi.fn(),
      decreaseProductStock: vi.fn().mockReturnValue(true),
    }))
    vi.mock('./alerts.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }))

    process.env.TG_BOT_TOKEN = 'test-token'
    process.env.TG_MANAGER_CHAT_ID = '111111'
    process.env.IMPORT_SHEET_ID = 'sheet123'
    process.env.ROBOKASSA_MERCHANT_LOGIN = 'merchant'
    process.env.ROBOKASSA_PASSWORD_1 = 'pass1'
    process.env.ROBOKASSA_PASSWORD_2 = 'pass2'

    const serverModule = await import('./server.js')
    processPaidOrder = serverModule.processPaidOrder

    const ordersSheet = await import('./orders-sheet.js')
    updateOrderStatusInSheet = ordersSheet.updateOrderStatusInSheet as ReturnType<typeof vi.fn>

    const ordersModule = await import('./orders.js')
    updateOrderStatus = ordersModule.updateOrderStatus as ReturnType<typeof vi.fn>

    const storeModule = await import('./store.js')
    decreaseProductStock = storeModule.decreaseProductStock as ReturnType<typeof vi.fn>

    const alertsModule = await import('./alerts.js')
    sendAlert = alertsModule.sendAlert as ReturnType<typeof vi.fn>
  })

  afterEach(() => {
    delete process.env.TG_BOT_TOKEN
    delete process.env.TG_MANAGER_CHAT_ID
  })

  it('already_paid: не обрабатывает повторно', async () => {
    const order = makeOrder('paid')
    const result = await processPaidOrder(order, '2500.00', '1717000000000', 'ORD-1717000000000')

    expect(result).toBe('already_paid')
    expect(updateOrderStatus).not.toHaveBeenCalled()
    expect(updateOrderStatusInSheet).not.toHaveBeenCalled()
    expect(decreaseProductStock).not.toHaveBeenCalled()
  })

  it('amount_mismatch: возвращает ошибку при расхождении суммы', async () => {
    const order = makeOrder('pending')
    const result = await processPaidOrder(order, '9999.00', '1717000000000', 'ORD-1717000000000')

    expect(result).toBe('amount_mismatch')
    expect(updateOrderStatus).not.toHaveBeenCalled()
    expect(sendAlert).toHaveBeenCalled()
  })

  it('ok: happy-path — обновляет статус, уменьшает сток, отправляет уведомления', async () => {
    const order = makeOrder('pending')
    const result = await processPaidOrder(order, '2500.00', '1717000000000', 'ORD-1717000000000')

    expect(result).toBe('ok')
    expect(updateOrderStatus).toHaveBeenCalledWith('ORD-1717000000000', 'paid')
    expect(updateOrderStatusInSheet).toHaveBeenCalledWith('ORD-1717000000000', 'paid', expect.any(Number))
    expect(decreaseProductStock).toHaveBeenCalledWith('ring-01', 1)
    // уведомления идут через sendTelegramMessage (fetch внутри server.ts)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('ok: failed-заказ обрабатывается как pending (Fail URL опередил)', async () => {
    const order = makeOrder('failed')
    const result = await processPaidOrder(order, '2500.00', '1717000000000', 'ORD-1717000000000')

    expect(result).toBe('ok')
    expect(updateOrderStatus).toHaveBeenCalledWith('ORD-1717000000000', 'paid')
  })

  it('ok: допускает расхождение суммы <= 0.01 (копейки)', async () => {
    const order = makeOrder('pending')
    // на 0.009 меньше — в пределах допуска (< 0.01)
    const result = await processPaidOrder(order, '2499.991', '1717000000000', 'ORD-1717000000000')

    expect(result).toBe('ok')
  })
})
