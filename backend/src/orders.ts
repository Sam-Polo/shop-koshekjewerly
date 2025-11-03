// простое in-memory хранилище заказов (для MVP)
// в будущем можно заменить на БД

export type OrderStatus = 'pending' | 'paid' | 'cancelled' | 'failed'

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
  }
  customerChatId?: string | null
}

const orders = new Map<string, Order>()

// создаем заказ
export function createOrder(orderId: string, orderData: Order['orderData'], customerChatId?: string | null): Order {
  const order: Order = {
    orderId,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    orderData,
    customerChatId
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

