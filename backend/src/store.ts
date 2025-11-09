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
    // сохраняем stock из памяти если он был изменен (меньше чем в таблице)
    // это позволяет не перезаписывать уменьшенный stock при импорте
    const preservedStock = existing?.stock !== undefined && it.stock !== undefined
      ? (existing.stock < it.stock ? existing.stock : it.stock) // берем меньший stock
      : (existing?.stock !== undefined ? existing.stock : it.stock) // если в таблице нет stock, сохраняем из памяти
    
    map.set(it.slug, { 
      ...existing, 
      ...it, 
      stock: preservedStock, // сохраняем уменьшенный stock
      createdAt: existing?.createdAt ?? Date.now() 
    })
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


