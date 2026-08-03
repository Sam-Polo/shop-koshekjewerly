import type { SheetProduct } from './sheets.js'

type Product = SheetProduct & { createdAt: number }

const state = {
  products: [] as Product[],
}

export function upsertProducts(items: SheetProduct[]) {
  const existingMap = new Map<string, Product>()
  for (const p of state.products) {
    existingMap.set(p.slug, p)
  }

  const newProducts: Product[] = []

  for (const it of items) {
    const existing = existingMap.get(it.slug)

    newProducts.push({
      ...it,
      // пустая ячейка stock в листе = безлимит, а не «пришло 0» — сохраняем прежнее значение
      stock: it.stock !== undefined ? it.stock : existing?.stock,
      createdAt: existing?.createdAt ?? Date.now(),
    })
  }

  state.products = newProducts
}

export function listProducts() {
  return state.products
}

// уменьшает сток в памяти сразу после оплаты (для мгновенного отображения в /api/products).
// Один slug может встречаться несколько раз (товар в нескольких категориях) — правим все копии,
// у них общий физический остаток. Авторитетную запись в Google Sheets делает decreaseStockInSheet
// (sheets.ts), вызывается отдельно из processPaidOrder.
export function decreaseProductStock(slug: string, quantity: number): boolean {
  const matches = state.products.filter(p => p.slug === slug)
  if (matches.length === 0) {
    return false
  }

  const stock = matches[0].stock
  if (stock === undefined) {
    return true // безлимит
  }

  if (stock < quantity) {
    return false
  }

  const next = stock - quantity
  for (const p of matches) {
    p.stock = next
  }

  return true
}

// категории, в которых у товара есть строка в Sheets (для записи остатка во все копии)
export function getProductCategories(slug: string): string[] {
  return state.products.filter(p => p.slug === slug).map(p => p.category)
}
