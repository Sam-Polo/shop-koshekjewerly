import { describe, it, expect, beforeAll } from 'vitest'
import crypto from 'node:crypto'

// robokassa.ts читает env на уровне модуля → задаём env ДО динамического импорта
let rk: typeof import('./robokassa.js')

const LOGIN = 'koshektest'
const PASS1 = 'pass1secret'

beforeAll(async () => {
  process.env.ROBOKASSA_MERCHANT_LOGIN = LOGIN
  process.env.ROBOKASSA_PASSWORD_1 = PASS1
  process.env.ROBOKASSA_PASSWORD_2 = 'pass2secret'
  process.env.ROBOKASSA_TAX = 'none'
  process.env.ROBOKASSA_SNO = 'usn_income'
  process.env.ROBOKASSA_PAYMENT_METHOD = 'full_payment'
  delete process.env.ROBOKASSA_TEST
  rk = await import('./robokassa.js')
})

// сумма всех позиций чека в копейках
function sumKopecks(receipt: NonNullable<ReturnType<typeof rk.buildReceipt>>): number {
  return receipt.items.reduce((s, it) => s + Math.round(it.sum * 100), 0)
}

describe('buildReceipt', () => {
  it('сумма позиций точно равна total (без скидки)', () => {
    const r = rk.buildReceipt({
      items: [
        { title: 'Кольцо', price: 5000, quantity: 1 },
        { title: 'Серьги', price: 3000, quantity: 2 },
      ],
      deliveryCost: 500,
      total: 5000 + 6000 + 500,
    })!
    expect(r).not.toBeNull()
    expect(sumKopecks(r)).toBe(1150000)
    expect(r.items).toHaveLength(3) // 2 товара + доставка
    expect(r.sno).toBe('usn_income')
    expect(r.items[0]).toMatchObject({ tax: 'none', payment_method: 'full_payment', payment_object: 'commodity' })
    expect(r.items[2]).toMatchObject({ name: 'Доставка', payment_object: 'service' })
  })

  it('распределяет скидку промокода, сумма сходится с total до копейки', () => {
    const items = [
      { title: 'Кольцо', price: 5000, quantity: 1 },
      { title: 'Серьги', price: 3000, quantity: 1 },
    ]
    const deliveryCost = 500
    const discount = 800
    const total = 5000 + 3000 + deliveryCost - discount // 7700
    const r = rk.buildReceipt({ items, deliveryCost, discount, total })!
    expect(r).not.toBeNull()
    expect(sumKopecks(r)).toBe(total * 100)
    expect(r.items.every(it => it.sum > 0)).toBe(true)
  })

  it('добавляет позицию приоритетной обработки', () => {
    const r = rk.buildReceipt({
      items: [{ title: 'Кольцо', price: 10000, quantity: 1 }],
      priorityFee: 3000,
      total: 13000,
    })!
    expect(sumKopecks(r)).toBe(1300000)
    expect(r.items.some(it => it.payment_object === 'service' && it.name.includes('риоритет'))).toBe(true)
  })

  it('сходится при дробном total (округление копеек)', () => {
    const r = rk.buildReceipt({
      items: [{ title: 'Кольцо', price: 100, quantity: 1 }],
      discount: 0.01,
      total: 99.99,
    })!
    expect(sumKopecks(r)).toBe(9999)
    expect(r.items[0].sum).toBeCloseTo(99.99, 2)
  })

  it('обрезает наименование до 128 символов', () => {
    const longTitle = 'Колье на заказ: '.repeat(20) // > 128
    const r = rk.buildReceipt({ items: [{ title: longTitle, price: 1000, quantity: 1 }], total: 1000 })!
    expect(r.items[0].name.length).toBe(128)
  })

  it('возвращает null при total = 0 и при пустом списке позиций', () => {
    expect(rk.buildReceipt({ items: [{ title: 'X', price: 1000, quantity: 1 }], total: 0 })).toBeNull()
    expect(rk.buildReceipt({ items: [], total: 1000 })).toBeNull()
  })
})

describe('buildPaymentForm — подпись с Receipt', () => {
  it('Receipt в поле формы и в подписи кодируется ровно один раз (enc1)', () => {
    const receipt = rk.buildReceipt({ items: [{ title: 'Кольцо Классика', price: 5000, quantity: 1 }], total: 5000 })!
    const { actionUrl, fields } = rk.buildPaymentForm({
      orderId: 'ORD-1', invoiceId: '1', amount: 5000, receipt, description: 'Заказ ORD-1', platform: 'telegram',
    })

    const enc1 = encodeURIComponent(JSON.stringify(receipt))
    expect(fields.Receipt).toBe(enc1)
    // round-trip: одно декодирование возвращает исходный JSON
    expect(decodeURIComponent(fields.Receipt)).toBe(JSON.stringify(receipt))

    // формат подписи: MerchantLogin:OutSum:InvId:Receipt:Password1:Shp_...(сортировка)
    const expected = crypto
      .createHash('md5')
      .update(`${LOGIN}:5000.00:1:${enc1}:${PASS1}:Shp_platform=telegram`, 'utf8')
      .digest('hex')
    expect(fields.SignatureValue).toBe(expected)
    expect(actionUrl).toContain('auth.robokassa.ru')
    expect(fields.OutSum).toBe('5000.00')
  })

  it('без Receipt подпись не содержит сегмент чека', () => {
    const { fields } = rk.buildPaymentForm({ orderId: 'ORD-2', invoiceId: '2', amount: 100, receipt: null })
    expect(fields.Receipt).toBeUndefined()
    const expected = crypto.createHash('md5').update(`${LOGIN}:100.00:2:${PASS1}`, 'utf8').digest('hex')
    expect(fields.SignatureValue).toBe(expected)
  })
})
