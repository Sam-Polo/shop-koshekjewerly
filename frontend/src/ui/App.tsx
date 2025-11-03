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
  onClose,
  onAddedToCart
}: { 
  product: Product
  cart: CartItem[]
  onAddToCart: (slug: string, quantity: number) => void
  onClose: () => void
  onAddedToCart: () => void
}) => {
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const [quantity, setQuantity] = useState(1)
  const cartItem = cart.find(item => item.slug === product.slug)
  const currentQuantity = cartItem?.quantity || 0
  const maxQuantity = product.stock !== undefined ? product.stock : 999
  const availableQuantity = Math.max(0, maxQuantity - currentQuantity)
  const canIncrease = quantity < availableQuantity
  const canAddToCart = quantity > 0 && quantity <= availableQuantity

  // сбрасываем quantity и изображение при открытии модалки
  useEffect(() => {
    setQuantity(1)
    setSelectedImageIndex(0)
  }, [product.slug])

  // разбиваем описание по переносам строк
  const descriptionLines = product.description 
    ? product.description.split('\n').filter(line => line.trim())
    : []

  const handleIncrease = () => {
    if (canIncrease) {
      setQuantity(prev => prev + 1)
    }
  }

  const handleDecrease = () => {
    if (quantity > 1) {
      setQuantity(prev => prev - 1)
    }
  }

  const handleAddToCart = () => {
    if (canAddToCart) {
      onAddToCart(product.slug, quantity)
      onAddedToCart()
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--product" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        
        {/* фото-галерея */}
        {product.images && product.images.length > 0 && (
          <div className="product-modal__gallery">
            <div className="product-modal__image-wrapper">
              <div 
                className="product-modal__image"
                style={{ backgroundImage: `url(${product.images[selectedImageIndex]})` }}
              />
              {product.images.length > 1 && (
                <>
                  <button
                    className="product-modal__arrow product-modal__arrow--prev"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelectedImageIndex(prev => prev === 0 ? product.images.length - 1 : prev - 1)
                    }}
                    aria-label="Предыдущее фото"
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  <button
                    className="product-modal__arrow product-modal__arrow--next"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelectedImageIndex(prev => prev === product.images.length - 1 ? 0 : prev + 1)
                    }}
                    aria-label="Следующее фото"
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M9 18l6-6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                </>
              )}
            </div>
            {product.images.length > 1 && (
              <div className="product-modal__thumbnails">
                {product.images.map((img, idx) => (
                  <button
                    key={idx}
                    className={`product-modal__thumbnail ${selectedImageIndex === idx ? 'active' : ''}`}
                    onClick={() => setSelectedImageIndex(idx)}
                    style={{ backgroundImage: `url(${img})` }}
                    aria-label={`Фото ${idx + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        
        <div className="product-modal__info">
          <h2 className="product-modal__title">{product.title}</h2>
          <p className="product-modal__price">{product.price_rub} ₽</p>
          
          {descriptionLines.length > 0 && (
            <div className="product-modal__description">
              {descriptionLines.map((line, idx) => (
                <p key={idx}>{line}</p>
              ))}
            </div>
          )}
          
          <div className="product-modal__cart-controls">
            <div className="cart-controls__quantity">
              <button 
                className="quantity-btn" 
                onClick={handleDecrease}
                disabled={quantity <= 1}
              >
                −
              </button>
              <span className="quantity-value">{quantity}</span>
              <button 
                className="quantity-btn" 
                onClick={handleIncrease}
                disabled={!canIncrease}
              >
                +
              </button>
            </div>
            {availableQuantity === 0 && (
              <p className="cart-controls__error">Товар закончился</p>
            )}
            {!canAddToCart && quantity > availableQuantity && availableQuantity > 0 && (
              <p className="cart-controls__error">Доступно только {availableQuantity} шт.</p>
            )}
            <button 
              className="btn btn--add-to-cart"
              onClick={handleAddToCart}
              disabled={!canAddToCart}
            >
              Добавить в корзину
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const ToastNotification = ({ message, onClose }: { message: string, onClose: () => void }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose()
    }, 2000)
    return () => clearTimeout(timer)
  }, [onClose])

  return (
    <div className="toast-notification">
      <span>{message}</span>
    </div>
  )
}

type DeliveryRegion = 'moscow' | 'russia' | 'cis' | 'europe'

const DELIVERY_COSTS: Record<DeliveryRegion, number> = {
  moscow: 350,
  russia: 500,
  cis: 650,
  europe: 1500
}

const DELIVERY_LABELS: Record<DeliveryRegion, string> = {
  moscow: 'По Москве и МО',
  russia: 'По России',
  cis: 'СНГ',
  europe: 'Европа'
}

// компонент выбора региона доставки
const DeliveryRegionSelector = ({ 
  onSelect 
}: { 
  onSelect: (region: DeliveryRegion) => void 
}) => {
  return (
    <div className="delivery-region-selector">
      <h3 className="delivery-region-selector__title">Выберите регион доставки</h3>
      <div className="delivery-region-selector__grid">
        {Object.entries(DELIVERY_LABELS).map(([key, label]) => (
          <button
            key={key}
            className="delivery-region-selector__option"
            onClick={() => onSelect(key as DeliveryRegion)}
          >
            <span className="delivery-region-selector__label">{label}</span>
            <span className="delivery-region-selector__cost">{DELIVERY_COSTS[key as DeliveryRegion]} ₽</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// компонент формы оформления заказа
const CheckoutForm = ({
  deliveryRegion,
  cartTotal,
  onBack,
  onSubmit
}: {
  deliveryRegion: DeliveryRegion
  cartTotal: number
  onBack: () => void
  onSubmit: (data: any) => void
}) => {
  const [formData, setFormData] = useState({
    fullName: '',
    phone: '',
    username: '',
    country: '',
    city: '',
    address: '',
    comments: ''
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  // получаем username из Telegram
  useEffect(() => {
    try {
      const tgUser = WebApp.initDataUnsafe?.user
      if (tgUser?.username) {
        setFormData(prev => ({ ...prev, username: `@${tgUser.username}` }))
      }
    } catch {}
  }, [])

  // автозаполнение страны
  useEffect(() => {
    if (deliveryRegion === 'moscow' || deliveryRegion === 'russia') {
      setFormData(prev => ({ ...prev, country: 'Россия' }))
    } else if (deliveryRegion === 'cis') {
      setFormData(prev => ({ ...prev, country: '' })) // пользователь выбирает
    } else if (deliveryRegion === 'europe') {
      setFormData(prev => ({ ...prev, country: '' })) // пользователь заполняет на латинице
    }
  }, [deliveryRegion])

  const isEurope = deliveryRegion === 'europe'
  const deliveryCost = DELIVERY_COSTS[deliveryRegion]
  const total = cartTotal + deliveryCost

  const validate = () => {
    const newErrors: Record<string, string> = {}
    
    if (!formData.fullName.trim()) {
      newErrors.fullName = 'Обязательное поле'
    }
    
    if (!formData.phone.trim()) {
      newErrors.phone = 'Обязательное поле'
    } else if (!/^[\d\s\-\+\(\)]+$/.test(formData.phone)) {
      newErrors.phone = 'Некорректный номер телефона'
    }
    
    if (!formData.country.trim()) {
      newErrors.country = 'Обязательное поле'
    }
    
    if (!formData.city.trim()) {
      newErrors.city = 'Обязательное поле'
    }
    
    if (!formData.address.trim()) {
      newErrors.address = 'Обязательное поле'
    }
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (validate()) {
      onSubmit({
        ...formData,
        deliveryRegion,
        deliveryCost,
        total
      })
    }
  }

  const handleChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  return (
    <form className="checkout-form" onSubmit={handleSubmit}>
      <button type="button" className="checkout-form__back" onClick={onBack}>
        ← Назад
      </button>
      
      <h3 className="checkout-form__title">Оформление заказа</h3>
      
      <div className="checkout-form__section">
        <label className="checkout-form__label">
          ФИО <span className="checkout-form__required">*</span>
          <input
            type="text"
            className={`checkout-form__input ${errors.fullName ? 'error' : ''}`}
            value={formData.fullName}
            onChange={(e) => handleChange('fullName', e.target.value)}
            placeholder={isEurope ? "Full Name" : "Иванов Иван Иванович"}
          />
          {errors.fullName && <span className="checkout-form__error">{errors.fullName}</span>}
        </label>

        <label className="checkout-form__label">
          Номер телефона <span className="checkout-form__required">*</span>
          <input
            type="tel"
            className={`checkout-form__input ${errors.phone ? 'error' : ''}`}
            value={formData.phone}
            onChange={(e) => handleChange('phone', e.target.value)}
            placeholder={isEurope ? "+1234567890" : "+7 (999) 123-45-67"}
          />
          {errors.phone && <span className="checkout-form__error">{errors.phone}</span>}
        </label>

        <label className="checkout-form__label">
          Telegram username
          <input
            type="text"
            className="checkout-form__input"
            value={formData.username}
            disabled
            placeholder="@username"
          />
        </label>

        <label className="checkout-form__label">
          Страна <span className="checkout-form__required">*</span>
          <input
            type="text"
            className={`checkout-form__input ${errors.country ? 'error' : ''}`}
            value={formData.country}
            onChange={(e) => handleChange('country', e.target.value)}
            placeholder={isEurope ? "Country" : "Россия"}
          />
          {errors.country && <span className="checkout-form__error">{errors.country}</span>}
        </label>

        <label className="checkout-form__label">
          Город <span className="checkout-form__required">*</span>
          <input
            type="text"
            className={`checkout-form__input ${errors.city ? 'error' : ''}`}
            value={formData.city}
            onChange={(e) => handleChange('city', e.target.value)}
            placeholder={isEurope ? "City" : "Москва"}
          />
          {errors.city && <span className="checkout-form__error">{errors.city}</span>}
        </label>

        <label className="checkout-form__label">
          {isEurope ? 'Домашний адрес' : 'Адрес пункта СДЭК'} <span className="checkout-form__required">*</span>
          <input
            type="text"
            className={`checkout-form__input ${errors.address ? 'error' : ''}`}
            value={formData.address}
            onChange={(e) => handleChange('address', e.target.value)}
            placeholder={isEurope ? "Street, Building, Apartment" : "Адрес пункта выдачи СДЭК"}
          />
          {errors.address && <span className="checkout-form__error">{errors.address}</span>}
        </label>

        <label className="checkout-form__label">
          Комментарии
          <textarea
            className="checkout-form__textarea"
            value={formData.comments}
            onChange={(e) => handleChange('comments', e.target.value)}
            placeholder={isEurope ? "Additional comments" : "Дополнительная информация к заказу"}
            rows={3}
          />
        </label>
      </div>

      <div className="checkout-form__summary">
        <div className="checkout-form__summary-row">
          <span>Товары:</span>
          <span>{cartTotal} ₽</span>
        </div>
        <div className="checkout-form__summary-row">
          <span>Доставка ({DELIVERY_LABELS[deliveryRegion]}):</span>
          <span>{deliveryCost} ₽</span>
        </div>
        <div className="checkout-form__summary-row checkout-form__summary-row--total">
          <span>Итого:</span>
          <strong>{total} ₽</strong>
        </div>
      </div>

      <button type="submit" className="btn btn--primary checkout-form__submit">
        Оформить заказ
      </button>
    </form>
  )
}

const CartModal = ({ 
  cart, 
  products, 
  onUpdateCart, 
  onClose,
  onCheckout
}: { 
  cart: CartItem[]
  products: Product[]
  onUpdateCart: (slug: string, delta: number) => void
  onClose: () => void
  onCheckout: () => void
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

  const handleCheckout = () => {
    // проверка stock перед оформлением заказа
    const invalidItems = cartItems.filter(item => {
      const maxQuantity = item.stock !== undefined ? item.stock : 999
      return item.quantity > maxQuantity
    })
    
    if (invalidItems.length > 0) {
      alert(`Недостаточно товара в наличии для:\n${invalidItems.map(i => i.title).join('\n')}`)
      return
    }
    
    onCheckout()
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
                          aria-label="Удалить товар"
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                          </svg>
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
              <button className="btn btn--primary" onClick={handleCheckout}>
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
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [checkoutStep, setCheckoutStep] = useState<'region' | 'form'>('region')
  const [deliveryRegion, setDeliveryRegion] = useState<DeliveryRegion | null>(null)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [cart, setCart] = useState<CartItem[]>([])
  const [toastMessage, setToastMessage] = useState<string | null>(null)
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
  
  // расчет суммы корзины
  const cartTotalPrice = cart.reduce((sum, item) => {
    const product = products.find(p => p.slug === item.slug)
    return sum + (product ? product.price_rub * item.quantity : 0)
  }, 0)

  const handleAddedToCart = () => {
    setToastMessage('Товар добавлен в корзину')
    setSelectedProduct(null) // закрываем модалку товара
  }

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
      if (checkoutOpen) {
        if (checkoutStep === 'form') {
          setCheckoutStep('region')
        } else {
          setCheckoutOpen(false)
          setCartOpen(true)
        }
      } else if (selectedProduct) {
        setSelectedProduct(null)
      } else if (cartOpen) {
        setCartOpen(false)
      } else if (aboutModalOpen) {
        setAboutModalOpen(false)
      } else if (selectedCategory) {
        setSelectedCategory(null)
      }
    }

    if (selectedProduct || cartOpen || aboutModalOpen || selectedCategory || checkoutOpen) {
      WebApp.BackButton.show()
      WebApp.BackButton.onClick(handleBackButtonClick)
    } else {
      WebApp.BackButton.hide()
    }

    if (selectedProduct || cartOpen || aboutModalOpen || checkoutOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = 'unset'
    }

    return () => {
      WebApp.BackButton.offClick(handleBackButtonClick)
      document.body.style.overflow = 'unset'
    }
  }, [selectedProduct, cartOpen, aboutModalOpen, selectedCategory, checkoutOpen, checkoutStep])

  const handleCheckoutStart = () => {
    setCartOpen(false)
    setCheckoutOpen(true)
    setCheckoutStep('region')
    setDeliveryRegion(null)
  }

  const handleDeliveryRegionSelect = (region: DeliveryRegion) => {
    setDeliveryRegion(region)
    setCheckoutStep('form')
  }

  const handleCheckoutSubmit = (data: any) => {
    // TODO: отправка заказа на бэкенд
    console.log('Order data:', data)
    alert('Заказ оформлен! Данные будут отправлены менеджеру.')
    setCheckoutOpen(false)
    setCart([])
  }


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
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span className="cart-button__badge">{cartTotal}</span>
        </button>
      )}

      {/* уведомление */}
      {toastMessage && (
        <ToastNotification 
          message={toastMessage} 
          onClose={() => setToastMessage(null)}
        />
      )}

      {aboutModalOpen && <AboutUsModal onClose={() => setAboutModalOpen(false)} />}
      {selectedProduct && (
        <ProductModal 
          product={selectedProduct}
          cart={cart}
          onAddToCart={updateCart}
          onClose={() => setSelectedProduct(null)}
          onAddedToCart={handleAddedToCart}
        />
      )}
      {cartOpen && (
        <CartModal 
          cart={cart}
          products={products}
          onUpdateCart={updateCart}
          onClose={() => setCartOpen(false)}
          onCheckout={handleCheckoutStart}
        />
      )}
      
      {checkoutOpen && (
        <div className="modal-overlay" onClick={() => setCheckoutOpen(false)}>
          <div className="modal-content modal-content--checkout" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setCheckoutOpen(false)}>&times;</button>
            {checkoutStep === 'region' ? (
              <DeliveryRegionSelector onSelect={handleDeliveryRegionSelect} />
            ) : deliveryRegion && (
              <CheckoutForm
                deliveryRegion={deliveryRegion}
                cartTotal={cartTotalPrice}
                onBack={() => setCheckoutStep('region')}
                onSubmit={handleCheckoutSubmit}
              />
            )}
          </div>
        </div>
      )}
    </>
  )
}


