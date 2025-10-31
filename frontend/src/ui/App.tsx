import { useEffect, useMemo, useState } from 'react'
import WebApp from '@twa-dev/sdk'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

export default function App() {
  const [ready, setReady] = useState(false)
  const [products, setProducts] = useState<Array<{ title: string }>>([])

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

  return (
    <div className="container">
      <h1>{title}</h1>
      {!ready && <p>загрузка…</p>}
      <div className="grid">
        {products.length === 0 && <p>каталог скоро будет</p>}
        {products.map((p, i) => (
          <div className="card" key={i}>
            <div className="card-title">{p.title}</div>
          </div>
        ))}
      </div>
      <div className="footer">© koshekjewerly</div>
    </div>
  )
}


