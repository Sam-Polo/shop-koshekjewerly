import { useEffect, useMemo, useState } from 'react'
import WebApp from '@twa-dev/sdk'

// по умолчанию используем относительный путь и vite proxy
const API_URL = import.meta.env.VITE_API_URL ?? ''

type Product = {
  id?: string
  slug: string
  title: string
  description?: string
  category: 'ягоды' | 'шея' | 'руки' | 'уши' | string
  price_rub: number
  images: string[]
  active: boolean
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [category, setCategory] = useState<Product['category'] | 'все'>('все')

  useEffect(() => {
    // инициализируем тему и кнопку назад
    try {
      WebApp.ready()
      WebApp.BackButton.show()
    } catch {}
    setReady(true)
  }, [])

  useEffect(() => {
    fetch(`${API_URL}/api/products`).then(r => r.json()).then(data => setProducts(data.items ?? [])).catch(() => setProducts([]))
  }, [])

  const title = useMemo(() => (WebApp.initDataUnsafe?.user?.first_name ? `привет, ${WebApp.initDataUnsafe.user.first_name}` : 'магазин украшений'), [])

  const categories: Array<{ key: Product['category']; title: string }> = [
    { key: 'ягоды', title: 'ягоды' },
    { key: 'шея', title: 'шея' },
    { key: 'руки', title: 'руки' },
    { key: 'уши', title: 'уши' },
  ]

  const filtered = category === 'все' ? products : products.filter(p => p.category === category)

  return (
    <div className="container">
      <h1>{title}</h1>
      <div className="toolbar">
        <button className="btn link" onClick={() => window.open('https://t.me/semyonp88', '_blank')}>написать менеджеру</button>
        <button className="btn" onClick={() => setCategory('все')}>все</button>
      </div>

      <div className="categories">
        {categories.map(c => (
          <div key={c.key} className="cat-tile" onClick={() => setCategory(c.key)}>
            <div className="cat-overlay"></div>
            <div className="cat-title">{c.title}</div>
          </div>
        ))}
      </div>

      {!ready && <p>загрузка…</p>}
      <div className="grid">
        {filtered.length === 0 && <p>каталог скоро будет</p>}
        {filtered.map((p) => (
          <div className="card" key={p.slug}>
            <div style={{ height: 96, borderRadius: 10, background: '#222', marginBottom: 8, backgroundImage: p.images?.[0] ? `url(${p.images[0]})` : undefined, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            <div className="card-title">{p.title}</div>
            <div style={{ opacity: 0.8 }}>{Math.round(p.price_rub).toLocaleString('ru-RU')} ₽</div>
          </div>
        ))}
      </div>
      <div className="footer">© koshekjewerly</div>
    </div>
  )
}


