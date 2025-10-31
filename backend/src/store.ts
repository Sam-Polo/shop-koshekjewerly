import type { SheetProduct } from './sheets'

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


