import { describe, it, expect, vi, beforeEach } from 'vitest'

const { amoFetch } = vi.hoisted(() => ({ amoFetch: vi.fn() }))
vi.mock('./amocrm-client.js', () => ({ amoFetch }))
vi.mock('./alerts.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./s3.js', () => ({ uploadBufferToS3: vi.fn() }))

import { createAmoCrmLead } from './amocrm.js'
import type { Order } from './orders.js'

function order(total: number): Order {
  return {
    orderId: 'ORD-1794474843104',
    status: 'paid',
    createdAt: 1794474843104,
    updatedAt: 1794474843104,
    customerChatId: '1',
    customerName: 'Тест',
    platform: 'telegram',
    orderData: {
      items: [{ slug: 'ring', title: 'Кольцо', price: 5990, quantity: 1 }],
      fullName: 'Тест Тестов',
      phone: '+79000000000',
      username: 'test',
      country: 'Россия',
      city: 'Москва',
      address: 'ПВЗ',
      deliveryRegion: '',
      deliveryCost: 293,
      total,
    },
  } as unknown as Order
}

describe('createAmoCrmLead', () => {
  beforeEach(() => {
    amoFetch.mockReset()
    amoFetch.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/contacts')) return { _embedded: { contacts: [{ id: 7 }] } }
      if (method === 'POST' && path === '/leads') return { _embedded: { leads: [{ id: 42 }] } }
      return {}
    })
  })

  // 20%-промокод даёт копейки (5026.4), а бюджет лида amoCRM принимает только целым:
  // дробь отбивалась 400 InvalidType, и лид не создавался вовсе
  it('отправляет бюджет лида целым числом, даже если в сумме заказа копейки', async () => {
    const leadId = await createAmoCrmLead(order(5026.4))

    expect(leadId).toBe(42)
    const post = amoFetch.mock.calls.find(([m, p]) => m === 'POST' && p === '/leads')!
    expect(post[2][0].price).toBe(5026)
  })
})
