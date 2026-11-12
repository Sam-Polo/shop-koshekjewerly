import { describe, it, expect } from 'vitest'
import { validatePromocode, isPromocodeExhausted, type Promocode } from './promocodes.js'

const base: Promocode = {
  code: 'TEST',
  type: 'amount',
  value: 100,
  active: true,
}

describe('isPromocodeExhausted', () => {
  it('без лимита промокод не исчерпывается', () => {
    expect(isPromocodeExhausted({ ...base, usedCount: 999 })).toBe(false)
  })

  it('исчерпан, когда счётчик дошёл до лимита', () => {
    expect(isPromocodeExhausted({ ...base, maxUses: 3, usedCount: 2 })).toBe(false)
    expect(isPromocodeExhausted({ ...base, maxUses: 3, usedCount: 3 })).toBe(true)
  })

  it('счётчик выше лимита (правка лимита вручную) тоже считается исчерпанным', () => {
    expect(isPromocodeExhausted({ ...base, maxUses: 2, usedCount: 5 })).toBe(true)
  })

  // сертификатные промокоды, выписанные до появления max_uses, лежат в Sheets
  // с пустой колонкой лимита, но остаются одноразовыми
  it('легаси-сертификат без max_uses одноразовый', () => {
    const legacy: Promocode = { ...base, source: 'certificate' }
    expect(isPromocodeExhausted({ ...legacy, usedCount: 0 })).toBe(false)
    expect(isPromocodeExhausted({ ...legacy, usedCount: 1 })).toBe(true)
  })

  it('явный max_uses у сертификата перебивает легаси-правило', () => {
    const promo: Promocode = { ...base, source: 'certificate', maxUses: 2 }
    expect(isPromocodeExhausted({ ...promo, usedCount: 1 })).toBe(false)
  })
})

describe('validatePromocode', () => {
  it('считает скидку, пока лимит не исчерпан', () => {
    expect(validatePromocode({ ...base, maxUses: 2, usedCount: 1 }, 1000)).toBe(100)
  })

  it('исчерпанный промокод не даёт скидки', () => {
    expect(validatePromocode({ ...base, maxUses: 2, usedCount: 2 }, 1000)).toBeNull()
  })

  it('неактивный промокод не даёт скидки', () => {
    expect(validatePromocode({ ...base, active: false }, 1000)).toBeNull()
  })

  it('истёкший промокод не даёт скидки', () => {
    const expired = { ...base, expiresAt: new Date(Date.now() - 86400_000).toISOString() }
    expect(validatePromocode(expired, 1000)).toBeNull()
  })

  it('скидка суммой не превышает сумму заказа', () => {
    expect(validatePromocode({ ...base, value: 5000 }, 1000)).toBe(1000)
  })

  // копеек в заказе быть не должно: скидка всегда в целых рублях, округление — в пользу покупателя
  it('процентная скидка — целыми рублями, копейки в пользу покупателя', () => {
    const percent: Promocode = { ...base, type: 'percent', value: 15 }
    expect(validatePromocode(percent, 333)).toBe(50) // 49.95 → 50
    const blackFriday: Promocode = { ...base, type: 'percent', value: 20 }
    expect(validatePromocode(blackFriday, 6283)).toBe(1257) // 1256.6 → 1257: итог 5026, а не 5026.4
  })

  it('ровная процентная скидка не получает лишний рубль из-за погрешности float', () => {
    // 3000 * 1.1 / 100 в float = 33.00000000000001 — голый Math.ceil дал бы 34
    expect(validatePromocode({ ...base, type: 'percent', value: 1.1 }, 3000)).toBe(33)
    expect(validatePromocode({ ...base, type: 'percent', value: 20 }, 4990)).toBe(998)
  })

  it('скидка суммой с копейками тоже округляется в пользу покупателя', () => {
    expect(validatePromocode({ ...base, value: 499.5 }, 1000)).toBe(500)
  })

  it('привязка к товарам: нет совпадений — нет скидки', () => {
    const bound: Promocode = { ...base, productSlugs: ['ring-a'] }
    expect(validatePromocode(bound, 1000, ['ring-b'])).toBeNull()
    expect(validatePromocode(bound, 1000, ['ring-b', 'ring-a'])).toBe(100)
  })
})
