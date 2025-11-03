import { useEffect, useState, useRef } from 'react'
import WebApp from '@twa-dev/sdk'
import React from 'react'

// изображения из public/assets с учетом base path
const baseUrl = import.meta.env.BASE_URL
const berriesImage = `${baseUrl}assets/berries-category.jpg`
const neckImage = `${baseUrl}assets/neck-category.jpg`
const handsImage = `${baseUrl}assets/hands-category.jpg`
const earsImage = `${baseUrl}assets/ears-category.jpg`
const certificateImage = `${baseUrl}assets/certificate-category.jpg`
const logoImage = `${baseUrl}assets/logo_.PNG`
const backgroundImage = `${baseUrl}assets/background.jpg`

type Category = {
  key: string
  title: string
  description?: string
  image: string
}

type Product = {
  slug: string
  title: string
  description?: string
  category: string
  price_rub: number
  images: string[]
  active: boolean
  stock?: number
}

const categories: Category[] = [
  { key: 'ягоды', title: 'Ягоды (special)', description: 'Эксклюзивная коллекция KOSHEK, украшения в виде реалистичных ягод из полимерной глины', image: berriesImage },
  { key: 'шея', title: 'Шея', description: 'Чокеры, колье, подвески, кулоны', image: neckImage },
  { key: 'руки', title: 'Руки', description: 'Браслеты, кольца', image: handsImage },
  { key: 'уши', title: 'Уши', description: 'Серьги, каффы', image: earsImage },
  { key: 'сертификаты', title: 'Сертификаты', image: certificateImage },
]

const AccordionItem = ({ question, children }: { question: string, children: React.ReactNode }) => {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <div className="accordion-item">
      <button className={`accordion-question ${isOpen ? 'open' : ''}`} onClick={() => setIsOpen(!isOpen)}>
        {question}
        <span className={`accordion-icon ${isOpen ? 'open' : ''}`}>&#9660;</span>
      </button>
      <div className={`accordion-answer ${isOpen ? 'open' : ''}`}>
        <div className="accordion-answer-content">
          {children}
        </div>
      </div>
    </div>
  )
}

const AboutUsModal = ({ onClose }: { onClose: () => void }) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className="modal-content" onClick={e => e.stopPropagation()}>
      <button className="modal-close" onClick={onClose}>&times;</button>
      <h3>О нас</h3>
      <p>ИП Силинская Олеся Станиславовна</p>
      <p>ИНН: 644112679372</p>
      <p>ОГРН: 318645100109495</p>
      <br />
      <p>Пока у нас нет оффлайн магазина, но мы принимаем заказы онлайн.</p>
      <p>Больше ассортимента и интересных предложений в наших социальных сетях.</p>
      <br />
      <h4>Ответы на ваши вопросы:</h4>
      <AccordionItem question="Как долго ждать?">
        <p>— Изготовление и сборка занимает 2-3 дня. Изделия из special collection (ягоды) около 4-6 дней.</p>
      </AccordionItem>
      <AccordionItem question="Как происходит доставка?">
        <p>— По Москве и МО: 350₽</p>
        <p>— По России: 500₽</p>
        <p>— СНГ: 650₽</p>
        <p>— Европа: 1500₽</p>
      </AccordionItem>
    </div>
  </div>
)

export default function App() {
  const [aboutModalOpen, setAboutModalOpen] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const mainContentRef = useRef<HTMLElement>(null)

  // загрузка товаров с бэкенда
  useEffect(() => {
    const apiUrl = import.meta.env.VITE_API_URL || '/api'
    fetch(`${apiUrl}/api/products`)
      .then(res => res.json())
      .then(data => {
        setProducts(data.items || [])
        setLoading(false)
      })
      .catch(err => {
        console.error('ошибка загрузки товаров:', err)
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    // инициализируем тему и кнопку назад
    try {
      WebApp.ready()
      WebApp.BackButton.hide()
    } catch {}
  }, [])

  useEffect(() => {
    const handleBackButtonClick = () => {
      if (aboutModalOpen) {
        setAboutModalOpen(false)
      } else if (selectedCategory) {
        setSelectedCategory(null)
      }
    }

    if (aboutModalOpen || selectedCategory) {
      WebApp.BackButton.show()
      WebApp.BackButton.onClick(handleBackButtonClick)
    } else {
      WebApp.BackButton.hide()
    }

    if (aboutModalOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = 'unset'
    }

    return () => {
      WebApp.BackButton.offClick(handleBackButtonClick)
      document.body.style.overflow = 'unset'
    }
  }, [aboutModalOpen, selectedCategory])


  // фильтруем товары по категории
  const filteredProducts = selectedCategory
    ? products.filter(p => p.category === selectedCategory)
    : products

  return (
    <>
      <header className="page-header" style={{ backgroundImage: `url(${backgroundImage})` }}>
        <img src={logoImage} alt="KOSHEK logo" className="header-logo" />
        <h1 className="page-header__title">KOSHEK</h1>
        <p className="page-header__text">Girls выбирают KOSHEK и бриллианты.</p>
        <button
          className="scroll-down-btn"
          onClick={() => mainContentRef.current?.scrollIntoView({ behavior: 'smooth' })}
          aria-label="Scroll down"
        />
      </header>

      <main className="page" ref={mainContentRef}>
        {!selectedCategory ? (
          // сетка категорий
          <section className="category-grid">
            {categories.map(card => (
              <button
                key={card.key}
                className="category-card"
                onClick={() => setSelectedCategory(card.key)}
              >
                <div className="category-card__media" style={{ backgroundImage: `url(${card.image})` }} />
                <div className="category-card__overlay" />
                <div className="category-card__content">
                  <h2 className="category-card__title">{card.title}</h2>
                  {card.description && <p className="category-card__description">{card.description}</p>}
                </div>
              </button>
            ))}
          </section>
        ) : (
          // грид товаров выбранной категории
          <section className="products-section">
            <h2 className="products-section__title">
              {categories.find(c => c.key === selectedCategory)?.title}
            </h2>
            {loading ? (
              <p className="products-loading">Загрузка...</p>
            ) : filteredProducts.length === 0 ? (
              <p className="products-empty">Товары скоро появятся</p>
            ) : (
              <div className="products-grid">
                {filteredProducts.map(product => (
                  <div key={product.slug} className="product-card">
                    <div
                      className="product-card__image"
                      style={{ backgroundImage: `url(${product.images[0]})` }}
                    />
                    <div className="product-card__info">
                      <h3 className="product-card__title">{product.title}</h3>
                      <p className="product-card__price">{product.price_rub} ₽</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        <footer className="page-footer">
          <button className="btn-text" onClick={() => window.open('https://t.me/semyonp88', '_blank')}>Поддержка</button>
          <button className="btn-text" onClick={() => setAboutModalOpen(true)}>О нас</button>
        </footer>
      </main>

      {aboutModalOpen && <AboutUsModal onClose={() => setAboutModalOpen(false)} />}
    </>
  )
}


