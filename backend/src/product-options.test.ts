import { describe, it, expect } from 'vitest'
import { parseProductOptions } from './sheets.js'

describe('parseProductOptions', () => {
  it('разбирает формат «Название: варианты»', () => {
    expect(parseProductOptions('Размер: 16, 17, 18')).toEqual({
      name: 'Размер',
      values: ['16', '17', '18'],
    })
  })

  it('терпит лишние пробелы вокруг названия и вариантов', () => {
    expect(parseProductOptions('  Длина цепочки :  40 см ,  45 см  ')).toEqual({
      name: 'Длина цепочки',
      values: ['40 см', '45 см'],
    })
  })

  it('без двоеточия считает строку списком вариантов с именем по умолчанию', () => {
    expect(parseProductOptions('16, 17')).toEqual({ name: 'Опция', values: ['16', '17'] })
  })

  it('пустая ячейка — товар без опций', () => {
    expect(parseProductOptions('')).toBeUndefined()
    expect(parseProductOptions('   ')).toBeUndefined()
  })

  it('название без вариантов не создаёт опцию (иначе выбирать нечего)', () => {
    expect(parseProductOptions('Размер:')).toBeUndefined()
    expect(parseProductOptions('Размер:  ,  ,')).toBeUndefined()
  })

  it('схлопывает дубликаты вариантов', () => {
    expect(parseProductOptions('Размер: 17, 17, 18')).toEqual({
      name: 'Размер',
      values: ['17', '18'],
    })
  })

  it('двоеточие внутри варианта не ломает разбор (делим по первому)', () => {
    expect(parseProductOptions('Гравировка: да: с текстом, нет')).toEqual({
      name: 'Гравировка',
      values: ['да: с текстом', 'нет'],
    })
  })

  it('ограничивает количество вариантов и длину строк', () => {
    const many = Array.from({ length: 40 }, (_, i) => String(i)).join(', ')
    const parsed = parseProductOptions(`Размер: ${many}`)
    expect(parsed!.values).toHaveLength(24)

    const long = parseProductOptions(`${'и'.repeat(80)}: ${'я'.repeat(80)}`)
    expect(long!.name.length).toBe(40)
    expect(long!.values[0].length).toBe(40)
  })
})
