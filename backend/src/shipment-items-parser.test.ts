import { describe, expect, it } from 'vitest'
import { parseAmoCrmComposition } from './shipment-items-parser.js'

describe('parseAmoCrmComposition — bot format', () => {
  it('parses two items (qty=1 each, real example from plan)', () => {
    const text = '[0006] Браслет Малинки — 5990₽\n[1816] Двойной чокер из Майорки с малиной — 5190₽'
    const { format, items } = parseAmoCrmComposition(text)
    expect(format).toBe('bot')
    expect(items).toEqual([
      { article: '0006', qty: 1 },
      { article: '1816', qty: 1 },
    ])
  })

  it('parses item with qty > 1 (× N)', () => {
    const { format, items } = parseAmoCrmComposition('[0006] Браслет Малинки × 2 — 11980₽')
    expect(format).toBe('bot')
    expect(items).toEqual([{ article: '0006', qty: 2 }])
  })

  it('preserves leading zeros in article', () => {
    const { items } = parseAmoCrmComposition('[0008] Подвеска Малинка — 3990₽')
    expect(items[0].article).toBe('0008')
  })

  it('skips empty lines between items', () => {
    const text = '[0006] Браслет — 5990₽\n\n[1816] Чокер — 5190₽'
    const { items } = parseAmoCrmComposition(text)
    expect(items).toHaveLength(2)
  })

  it('handles single item', () => {
    const { items } = parseAmoCrmComposition('[0006] Браслет Малинки — 5990₽')
    expect(items).toEqual([{ article: '0006', qty: 1 }])
  })
})

describe('parseAmoCrmComposition — tilda format', () => {
  it('parses two items merged in one string (real example from plan)', () => {
    const text = 'Подвеска Малинка (0008) x 1 ≡ 3990Браслет Малинки (0006) x 1 ≡ 5990'
    const { format, items } = parseAmoCrmComposition(text)
    expect(format).toBe('tilda')
    expect(items).toEqual([
      { article: '0008', qty: 1 },
      { article: '0006', qty: 1 },
    ])
  })

  it('parses item with qty > 1', () => {
    const { format, items } = parseAmoCrmComposition('Браслет Малинки (0006) x 3 ≡ 17970')
    expect(format).toBe('tilda')
    expect(items).toEqual([{ article: '0006', qty: 3 }])
  })

  it('handles single item', () => {
    const { items } = parseAmoCrmComposition('Подвеска Малинка (0008) x 1 ≡ 3990')
    expect(items).toEqual([{ article: '0008', qty: 1 }])
  })

  it('handles name with digits before article (e.g. Чокер 2.0)', () => {
    // The nesting of digits in the name should not confuse the parser
    // because we match `(article) x qty ≡ price` pattern, not just any `(digits)`
    const text = 'Чокер 2.0 (1816) x 1 ≡ 5190'
    const { items } = parseAmoCrmComposition(text)
    expect(items).toEqual([{ article: '1816', qty: 1 }])
  })
})

describe('parseAmoCrmComposition — unknown / edge cases', () => {
  it('returns unknown for plain unstructured text', () => {
    const { format, items } = parseAmoCrmComposition('просто текст без структуры')
    expect(format).toBe('unknown')
    expect(items).toHaveLength(0)
  })

  it('returns unknown for empty string', () => {
    const { format, items } = parseAmoCrmComposition('')
    expect(format).toBe('unknown')
    expect(items).toHaveLength(0)
  })

  it('returns unknown for whitespace-only string', () => {
    const { format, items } = parseAmoCrmComposition('   ')
    expect(format).toBe('unknown')
    expect(items).toHaveLength(0)
  })

  it('handles null input without throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { format, items } = parseAmoCrmComposition(null as any)
    expect(format).toBe('unknown')
    expect(items).toHaveLength(0)
  })
})
