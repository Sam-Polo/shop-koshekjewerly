import type { SheetProduct } from './sheets.js'

type Product = SheetProduct & { createdAt: number }

const state = {
  products: [] as Product[],
  // accumulated stock decreases from payments not yet reflected in the sheet
  paymentDecreases: new Map<string, number>(),
}

export function upsertProducts(items: SheetProduct[]) {
  const existingMap = new Map<string, Product>()
  for (const p of state.products) {
    existingMap.set(p.slug, p)
  }

  const newProducts: Product[] = []

  for (const it of items) {
    const existing = existingMap.get(it.slug)
    const paymentDecrease = state.paymentDecreases.get(it.slug) ?? 0

    // Trust the sheet as source of truth, subtract only unacknowledged payment decreases.
    // This lets the manager restore stock by updating the sheet value.
    const finalStock = it.stock !== undefined
      ? Math.max(0, it.stock - paymentDecrease)
      : existing?.stock

    newProducts.push({
      ...it,
      stock: finalStock,
      createdAt: existing?.createdAt ?? Date.now(),
    })
  }

  // Sheet is now authoritative — manager has seen sales and set the correct value.
  state.paymentDecreases.clear()
  state.products = newProducts
}

export function listProducts() {
  return state.products
}

// decrease stock after successful payment; tracks the delta until next sheet import
export function decreaseProductStock(slug: string, quantity: number): boolean {
  const product = state.products.find(p => p.slug === slug)
  if (!product) {
    return false
  }

  if (product.stock === undefined) {
    return true
  }

  if (product.stock < quantity) {
    return false
  }

  product.stock -= quantity
  state.paymentDecreases.set(slug, (state.paymentDecreases.get(slug) ?? 0) + quantity)

  return true
}
