import type { SheetProduct } from './sheets.js'

type Product = SheetProduct & { createdAt: number }

const state = {
  products: [] as Product[],
}

export function upsertProducts(items: SheetProduct[]) {
  const map = new Map<string, Product>()
  for (const p of state.products) map.set(p.slug, p)
  for (const it of items) {
    const existing = map.get(it.slug)
    map.set(it.slug, { ...existing, ...it, createdAt: existing?.createdAt ?? Date.now() })
  }
  state.products = Array.from(map.values())
}

export function listProducts() {
  return state.products
}

// уменьшаем stock товара после успешной оплаты
export function decreaseProductStock(slug: string, quantity: number): boolean {
  const product = state.products.find(p => p.slug === slug)
  if (!product) {
    return false
  }
  
  // если stock не задан (undefined), считаем что товар безлимитный
  if (product.stock === undefined) {
    return true
  }
  
  // проверяем что stock достаточен
  if (product.stock < quantity) {
    return false
  }
  
  // уменьшаем stock
  product.stock -= quantity
  
  return true
}


