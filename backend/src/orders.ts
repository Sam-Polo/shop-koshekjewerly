// простое in-memory хранилище заказов (для MVP)
// в будущем можно заменить на БД

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'failed'

export type Platform = 'telegram' | 'max'

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
    /** приоритетный заказ: +30% к сумме после скидки */
    priorityOrder?: boolean
    priorityFee?: number
    promocode?: {
      code: string
      type: 'amount' | 'percent'
      value: number
      discount: number
    }
  }
  customerChatId?: string | null
  /** имя пользователя из initData (для MAX — first_name + last_name) */
  customerName?: string | null
  /** платформа, с которой создан заказ (telegram или max) */
  platform?: Platform
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

