// простое in-memory хранилище заказов (для MVP)
// в будущем можно заменить на БД

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'failed'

export type Platform = 'telegram' | 'max'

/** способ доставки: самовывоз / СДЭК ПВЗ / EMS Почта России (международная) */
export type DeliveryMethod = 'pickup' | 'cdek' | 'ems'

export type Order = {
  orderId: string
  status: OrderStatus
  createdAt: number
  updatedAt: number
  orderData: {
    items: Array<{
      slug: string
      title: string
      price: number
      quantity: number
      article?: string // артикул товара
    }>
    fullName: string
    phone: string
    username?: string
    country: string
    city: string
    address: string
    deliveryRegion: string
    deliveryCost: number
    total: number
    comments?: string
    /** способ доставки (главный дискриминатор маршрутизации отправления) */
    deliveryMethod?: DeliveryMethod
    /** код ПВЗ СДЭК (обязателен для создания отправления СДЭК) */
    pvzCode?: string
    /** CDEK city code (для расчёта стоимости и создания отправления) */
    cdekCityCode?: number
    /** EMS Почта России — реквизиты получателя международного отправления */
    recipientCountry?: string
    /** ОКСМ числовой код страны получателя (mail-direct для тарифа/заказа Почты) */
    recipientCountryCode?: number
    recipientRegion?: string
    recipientCity?: string
    recipientStreet?: string
    recipientIndex?: string
    /** приоритетный заказ: +30% к сумме после скидки */
    priorityOrder?: boolean
    priorityFee?: number
    promocode?: {
      code: string
      type: 'amount' | 'percent'
      value: number
      discount: number
    }
    /** согласие покупателя на обработку ПДн — храним «для галочки» (152-ФЗ), на логику не влияет */
    consent?: boolean
  }
  customerChatId?: string | null
  /** имя пользователя из initData (для MAX — first_name + last_name) */
  customerName?: string | null
  /** платформа, с которой создан заказ (telegram или max) */
  platform?: Platform
  /** UUID заказа в системе СДЭК */
  cdekUuid?: string | null
  /** трек-номер СДЭК */
  cdekTrackNumber?: string | null
  /** ШПИ (трек) EMS Почты России */
  pochtaShpi?: string | null
  /** имя партии Почты России (для печати форм / отладки) */
  pochtaBatchName?: string | null
}

const orders = new Map<string, Order>()

// создаем заказ
export function createOrder(orderId: string, orderData: Order['orderData'], customerChatId?: string | null, platform?: Platform, customerName?: string | null): Order {
  const order: Order = {
    orderId,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    orderData,
    customerChatId,
    customerName,
    platform: platform ?? 'telegram'
  }
  orders.set(orderId, order)
  return order
}

// получаем заказ
export function getOrder(orderId: string): Order | undefined {
  return orders.get(orderId)
}

// обновляем статус заказа
export function updateOrderStatus(orderId: string, status: OrderStatus): Order | null {
  const order = orders.get(orderId)
  if (!order) {
    return null
  }
  
  order.status = status
  order.updatedAt = Date.now()
  orders.set(orderId, order)
  
  return order
}

// получаем все заказы (для админки)
export function listOrders(): Order[] {
  return Array.from(orders.values()).sort((a, b) => b.createdAt - a.createdAt)
}

// восстанавливаем заказ из внешнего хранилища (Sheets) в память.
// не перезаписывает, если заказ уже есть — память всегда актуальнее Sheets.
export function restoreOrder(order: Order): boolean {
  if (orders.has(order.orderId)) return false
  orders.set(order.orderId, order)
  return true
}

