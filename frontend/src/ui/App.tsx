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

type CartItem = {
  slug: string
  quantity: number
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

const ProductModal = ({ 
  product, 
  cart, 
  onAddToCart, 
  onClose 
}: { 
  product: Product
  cart: CartItem[]
  onAddToCart: (slug: string, quantity: number) => void
  onClose: () => void 
}) => {
  const cartItem = cart.find(item => item.slug === product.slug)
  const currentQuantity = cartItem?.quantity || 0
  const maxQuantity = product.stock !== undefined ? product.stock : 999
  const canAddMore = currentQuantity < maxQuantity

  const handleAdd = () => {
    if (canAddMore) {
      onAddToCart(product.slug, 1)
    }
  }

  const handleRemove = () => {
    if (currentQuantity > 0) {
      onAddToCart(product.slug, -1)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--product" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        
        {product.images && product.images.length > 0 && (
          <div 
            className="product-modal__image"
            style={{ backgroundImage: `url(${product.images[0]})` }}
          />
        )}
        
        <div className="product-modal__info">
          <h2 className="product-modal__title">{product.title}</h2>
          <p className="product-modal__price">{product.price_rub} ₽</p>
          
          {product.description && (
            <div className="product-modal__description">
              <p>{product.description}</p>
            </div>
          )}
          
          {product.stock !== undefined && (
            <p className="product-modal__stock">
              В наличии: {product.stock} шт.
            </p>
          )}
          
          <div className="product-modal__cart-controls">
            <div className="cart-controls__quantity">
              <button 
                className="quantity-btn" 
                onClick={handleRemove}
                disabled={currentQuantity === 0}
              >
                −
              </button>
              <span className="quantity-value">{currentQuantity}</span>
              <button 
                className="quantity-btn" 
                onClick={handleAdd}
                disabled={!canAddMore}
              >
                +
              </button>
            </div>
            {!canAddMore && currentQuantity >= maxQuantity && (
              <p className="cart-controls__error">Достигнут лимит остатка</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const CartModal = ({ 
  cart, 
  products, 
  onUpdateCart, 
  onClose 
}: { 
  cart: CartItem[]
  products: Product[]
  onUpdateCart: (slug: string, delta: number) => void
  onClose: () => void 
}) => {
  const cartItems = cart
    .map(item => {
      const product = products.find(p => p.slug === item.slug)
      return product ? { ...product, quantity: item.quantity } : null
    })
    .filter(Boolean) as (Product & { quantity: number })[]

  const total = cartItems.reduce((sum, item) => sum + item.price_rub * item.quantity, 0)

  const handleRemove = (slug: string) => {
    onUpdateCart(slug, -999) // удаляем всё
  }

  const handleQuantityChange = (slug: string, delta: number) => {
    onUpdateCart(slug, delta)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--cart" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2 className="cart-modal__title">Корзина</h2>
        
        {cartItems.length === 0 ? (
          <p className="cart-modal__empty">Корзина пуста</p>
        ) : (
          <>
            <div className="cart-modal__items">
              {cartItems.map(item => {
                const maxQuantity = item.stock !== undefined ? item.stock : 999
                const canAddMore = item.quantity < maxQuantity
                
                return (
                  <div key={item.slug} className="cart-item">
                    {item.images && item.images.length > 0 && (
                      <div 
                        className="cart-item__image"
                        style={{ backgroundImage: `url(${item.images[0]})` }}
                      />
                    )}
                    <div className="cart-item__info">
                      <h3 className="cart-item__title">{item.title}</h3>
                      <p className="cart-item__price">{item.price_rub} ₽ × {item.quantity}</p>
                      <div className="cart-item__controls">
                        <button 
                          className="quantity-btn" 
                          onClick={() => handleQuantityChange(item.slug, -1)}
                          disabled={item.quantity === 0}
                        >
                          −
                        </button>
                        <span className="quantity-value">{item.quantity}</span>
                        <button 
                          className="quantity-btn" 
                          onClick={() => handleQuantityChange(item.slug, 1)}
                          disabled={!canAddMore}
                        >
                          +
                        </button>
                        <button 
                          className="cart-item__remove"
                          onClick={() => handleRemove(item.slug)}
                        >
                          Удалить
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            
            <div className="cart-modal__footer">
              <div className="cart-modal__total">
                <span>Итого:</span>
                <strong>{total} ₽</strong>
              </div>
              <button className="btn btn--primary" onClick={() => {
                // проверка stock перед оформлением заказа
                const invalidItems = cartItems.filter(item => {
                  const maxQuantity = item.stock !== undefined ? item.stock : 999
                  return item.quantity > maxQuantity
                })
                
                if (invalidItems.length > 0) {
                  alert(`Недостаточно товара в наличии для:\n${invalidItems.map(i => i.title).join('\n')}`)
                  return
                }
                
                // TODO: отправка заказа на бэкенд
                alert('Оформление заказа скоро будет доступно')
              }}>
                Оформить заказ
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function App() {
  const [aboutModalOpen, setAboutModalOpen] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [cart, setCart] = useState<CartItem[]>([])
  const mainContentRef = useRef<HTMLElement>(null)

  // управление корзиной с проверкой stock
  const updateCart = (slug: string, delta: number) => {
    setCart(prev => {
      const existing = prev.find(item => item.slug === slug)
      const product = products.find(p => p.slug === slug)
      if (!product) return prev

      const maxQuantity = product.stock !== undefined ? product.stock : 999
      
      if (delta < 0) {
        // уменьшение
        if (!existing || existing.quantity === 0) return prev
        const newQuantity = Math.max(0, existing.quantity + delta)
        if (newQuantity === 0) {
          return prev.filter(item => item.slug !== slug)
        }
        return prev.map(item => 
          item.slug === slug 
            ? { ...item, quantity: newQuantity }
            : item
        )
      } else {
        // увеличение
        const currentQty = existing?.quantity || 0
        const newQuantity = Math.min(maxQuantity, currentQty + delta)
        
        if (currentQty === 0) {
          // добавляем новый товар
          return [...prev, { slug, quantity: newQuantity }]
        } else {
          // обновляем существующий
          return prev.map(item => 
            item.slug === slug 
              ? { ...item, quantity: newQuantity }
              : item
          )
        }
      }
    })
  }

  const cartTotal = cart.reduce((sum, item) => sum + item.quantity, 0)

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
      if (selectedProduct) {
        setSelectedProduct(null)
      } else if (cartOpen) {
        setCartOpen(false)
      } else if (aboutModalOpen) {
        setAboutModalOpen(false)
      } else if (selectedCategory) {
        setSelectedCategory(null)
      }
    }

    if (selectedProduct || cartOpen || aboutModalOpen || selectedCategory) {
      WebApp.BackButton.show()
      WebApp.BackButton.onClick(handleBackButtonClick)
    } else {
      WebApp.BackButton.hide()
    }

    if (selectedProduct || cartOpen || aboutModalOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = 'unset'
    }

    return () => {
      WebApp.BackButton.offClick(handleBackButtonClick)
      document.body.style.overflow = 'unset'
    }
  }, [selectedProduct, cartOpen, aboutModalOpen, selectedCategory])


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
                  <div 
                    key={product.slug} 
                    className="product-card"
                    onClick={() => setSelectedProduct(product)}
                  >
                    {product.images && product.images.length > 0 ? (
                      <div
                        className="product-card__image"
                        style={{ backgroundImage: `url(${product.images[0]})` }}
                      />
                    ) : (
                      <div className="product-card__image product-card__image--placeholder" />
                    )}
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

      {/* кнопка корзины (плавающая) */}
      {cartTotal > 0 && (
        <button 
          className="cart-button"
          onClick={() => setCartOpen(true)}
          aria-label="Корзина"
        >
          🛒 <span className="cart-button__badge">{cartTotal}</span>
        </button>
      )}

      {aboutModalOpen && <AboutUsModal onClose={() => setAboutModalOpen(false)} />}
      {selectedProduct && (
        <ProductModal 
          product={selectedProduct}
          cart={cart}
          onAddToCart={updateCart}
          onClose={() => setSelectedProduct(null)}
        />
      )}
      {cartOpen && (
        <CartModal 
          cart={cart}
          products={products}
          onUpdateCart={updateCart}
          onClose={() => setCartOpen(false)}
        />
      )}
    </>
  )
}


