import { useEffect, useMemo, useState } from 'react'
import WebApp from '@twa-dev/sdk'

// по умолчанию используем относительный путь и vite proxy
const API_URL = import.meta.env.VITE_API_URL ?? ''
const MANAGER_LINK = 'https://t.me/semyonp88'

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

type CategorySection = {
  key: Product['category']
  title: string
  subtitle: string
  badge?: string
  anchor: string
}

const NAV_LINKS = [
  { href: '#hero', label: 'главная' },
  { href: '#catalog', label: 'каталог' },
  { href: '#delivery', label: 'доставка' },
  { href: '#contacts', label: 'контакты' },
]

const CATEGORY_SECTIONS: CategorySection[] = [
  { key: 'ягоды', title: 'ягоды special', subtitle: 'капсула с ягодами и жемчугом', badge: 'new', anchor: 'section-berries' },
  { key: 'шея', title: 'чокеры и колье', subtitle: 'жемчуг, натуральные камни и минералы', anchor: 'section-neck' },
  { key: 'руки', title: 'браслеты', subtitle: 'кастомные украшения на запястье', anchor: 'section-hands' },
  { key: 'уши', title: 'серьги и кафы', subtitle: 'объёмные формы и фурнитура с позолотой', anchor: 'section-ears' },
]

const SKELETON_COUNT = 6

export default function App() {
  const [isReady, setIsReady] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeFilter, setActiveFilter] = useState<CategorySection['key'] | 'все'>('все')

  useEffect(() => {
    // готовим миниапку и показываем backButton
    try {
      WebApp.ready()
      WebApp.BackButton.show()
    } catch {}
    setIsReady(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    fetch(`${API_URL}/api/products`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        const list: Product[] = Array.isArray(data?.items) ? data.items : []
        setProducts(list.filter((item) => item && item.title))
      })
      .catch(() => {
        if (cancelled) return
        setProducts([])
      })
      .finally(() => {
        if (cancelled) return
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const greeting = useMemo(() => {
    const firstName = WebApp.initDataUnsafe?.user?.first_name
    return firstName ? `привет, ${firstName}` : 'koshek'
  }, [])

  const groupedByCategory = useMemo(() => {
    const next: Record<string, Product[]> = {}
    CATEGORY_SECTIONS.forEach((section) => {
      next[section.key] = []
    })
    products
      .filter((product) => product.active !== false)
      .forEach((product) => {
        if (!next[product.category]) {
          next[product.category] = []
        }
        next[product.category].push(product)
      })
    return next
  }, [products])

  const featuredProducts = useMemo(() => {
    const visible = products.filter((product) => product.active !== false)
    if (activeFilter === 'все') return visible
    return groupedByCategory[activeFilter] ?? []
  }, [products, groupedByCategory, activeFilter])

  const activeSection = CATEGORY_SECTIONS.find((section) => section.key === activeFilter) ?? null

  const handleOpenManager = () => {
    // открываем диалог с менеджером внутри telegram
    try {
      WebApp.openTelegramLink(MANAGER_LINK)
    } catch {
      window.open(MANAGER_LINK, '_blank')
    }
  }

  const scrollToCatalog = () => {
    // прокручиваем к блоку каталога
    document.getElementById('catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const triggerHaptic = () => {
    // лёгкая вибрация при клике
    try {
      WebApp.HapticFeedback.impactOccurred('light')
    } catch {}
  }

  const renderSkeletons = () =>
    Array.from({ length: SKELETON_COUNT }, (_, index) => (
      <div className="product-card skeleton" key={`skeleton-${index}`}>
        <div className="product-media" />
        <div className="product-body">
          <div className="skeleton-line short" />
          <div className="skeleton-line" />
          <div className="skeleton-line tiny" />
        </div>
      </div>
    ))

  const renderProducts = (items: Product[]) =>
    items.map((product) => {
      const cover = product.images?.[0]
      const price = Number.isFinite(product.price_rub) ? Math.round(product.price_rub).toLocaleString('ru-RU') : '—'
      return (
        <div className="product-card" key={product.slug}>
          <div className="product-media" style={cover ? { backgroundImage: `url(${cover})` } : undefined} />
          <div className="product-body">
            <div className="product-title">{product.title}</div>
            <div className="product-price">{price} ₽</div>
            <button
              className="ghost-button"
              onClick={() => {
                triggerHaptic()
              }}
            >
              в корзину
            </button>
          </div>
        </div>
      )
    })

  return (
    <div className="page">
      <header className="header">
        <div className="brand">koshek</div>
        <nav className="nav">
          {NAV_LINKS.map((link) => (
            <a key={link.href} className="nav-link" href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
        <button className="primary-button hidden-mobile" onClick={handleOpenManager}>
          написать менеджеру
        </button>
      </header>

      <main>
        <section className="hero" id="hero">
          <div className="hero-text">
            <p className="hero-eyebrow">{greeting}</p>
            <h1 className="hero-title">трендовые украшения повышающие градус вашего стиля</h1>
            <p className="hero-copy">
              натуральный жемчуг, камни и кастомные цепи — создаём украшения, которые живут вместе с вами каждый день.
            </p>
            <div className="hero-actions">
              <button className="primary-button" onClick={scrollToCatalog}>
                в каталог
              </button>
              <button className="ghost-button" onClick={handleOpenManager}>
                чат с менеджером
              </button>
            </div>
          </div>
          <div className="hero-visual">
            <div className="hero-placeholder" />
            <span className="hero-note">заглушка баннера • заменим на фото</span>
          </div>
        </section>

        <section className="catalog" id="catalog">
          <div className="section-header">
            <div>
              <p className="section-eyebrow">категории</p>
              <h2 className="section-title">стиль, уникальность, качество</h2>
            </div>
            <button className="ghost-button hidden-desktop" onClick={handleOpenManager}>
              написать менеджеру
            </button>
          </div>

          <div className="category-grid">
            {CATEGORY_SECTIONS.map((section) => (
              <button
                key={section.key}
                className={`category-card ${activeFilter === section.key ? 'active' : ''}`}
                onClick={() => {
                  triggerHaptic()
                  setActiveFilter(section.key)
                  document.getElementById(section.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >
                <span className="category-placeholder" />
                <span className="category-label">{section.title}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="featured" id="featured">
          <div className="section-header">
            <div>
              <p className="section-eyebrow">подборка</p>
              <h2 className="section-title">{activeSection ? activeSection.title : 'все украшения'}</h2>
            </div>
            <p className="section-copy">{activeSection ? activeSection.subtitle : 'подборка по всем категориям из каталога'}</p>
          </div>

          <div className="product-grid">
            {isLoading && renderSkeletons()}
            {!isLoading && featuredProducts.length === 0 && <p className="empty">каталог скоро будет</p>}
            {!isLoading && renderProducts(featuredProducts)}
          </div>
        </section>

        {CATEGORY_SECTIONS.map((section) => {
          const items = groupedByCategory[section.key] ?? []
          return (
            <section className="category-section" id={section.anchor} key={section.key}>
              <div className="section-header">
                <div>
                  {section.badge && <span className="badge">{section.badge}</span>}
                  <h2 className="section-title">{section.title}</h2>
                </div>
                <p className="section-copy">{section.subtitle}</p>
              </div>
              <div className="product-grid compact">
                {isLoading && renderSkeletons()}
                {!isLoading && items.length === 0 && <p className="empty">товары скоро появятся</p>}
                {!isLoading && renderProducts(items)}
              </div>
            </section>
          )
        })}

        <section className="info" id="delivery">
          <div className="info-card">
            <h3 className="info-title">доставка и оплата</h3>
            <p className="info-copy">
              доставка по россии и снг, уточняем стоимость индивидуально после подтверждения заказа. оплату подключим позже — сейчас оформляем заказ и связываемся с вами в telegram.
            </p>
          </div>
          <div className="info-card">
            <h3 className="info-title">что внутри заказа</h3>
            <ul className="info-list">
              <li>натуральные материалы, проверенная фурнитура</li>
              <li>индивидуальная подгонка длины по запросу</li>
              <li>бережная упаковка и памятка по уходу</li>
            </ul>
          </div>
        </section>

        <section className="contacts" id="contacts">
          <div className="contacts-card">
            <h3 className="info-title">связаться</h3>
            <p className="info-copy">телефон: <a href="tel:+79878102838">+7 987 810-28-38</a></p>
            <p className="info-copy">email: <a href="mailto:olesiasee@mail.ru">olesiasee@mail.ru</a></p>
            <button className="primary-button" onClick={handleOpenManager}>
              написать в telegram
            </button>
          </div>
          <div className="contacts-card">
            <h3 className="info-title">реквизиты</h3>
            <p className="info-copy">ип силинская олесия станиславовна</p>
            <p className="info-copy">инн: 644112679372</p>
            <p className="info-copy">огрн: 318645100109495</p>
            <p className="info-copy">онлайн-магазин, заказы принимаем круглосуточно</p>
          </div>
        </section>
      </main>

      <footer className="footer">© koshek jewelry • made for telegram mini app</footer>

      {!isReady && <div className="overlay">загрузка…</div>}
    </div>
  )
}


