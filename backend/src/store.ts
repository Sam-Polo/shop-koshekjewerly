import type { SheetProduct } from './sheets.js'

type Product = SheetProduct & { createdAt: number }

const state = {
  products: [] as Product[],
}

export function upsertProducts(items: SheetProduct[]) {
  // создаем Map из существующих товаров для сохранения stock
  const existingMap = new Map<string, Product>()
  for (const p of state.products) {
    existingMap.set(p.slug, p)
  }
  
  // создаем новый список товаров только из импортированных
  const newProducts: Product[] = []
  
  for (const it of items) {
    const existing = existingMap.get(it.slug)
    
    // сохраняем stock из памяти если он был изменен (меньше чем в таблице)
    // это позволяет не перезаписывать уменьшенный stock при импорте
    const preservedStock = existing?.stock !== undefined && it.stock !== undefined
      ? (existing.stock < it.stock ? existing.stock : it.stock) // берем меньший stock
      : (existing?.stock !== undefined ? existing.stock : it.stock) // если в таблице нет stock, сохраняем из памяти
    
    newProducts.push({ 
      ...it, 
      stock: preservedStock, // сохраняем уменьшенный stock
      createdAt: existing?.createdAt ?? Date.now() 
    })
  }
  
  // полностью заменяем список товаров (удаляем те, которых нет в новом импорте)
  state.products = newProducts
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


