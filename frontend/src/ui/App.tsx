import { useEffect, useState, useRef } from 'react'
import WebApp, { platform as appPlatform } from '../platform/webApp'
import React from 'react'
import { Swiper, SwiperSlide, type SwiperClass } from 'swiper/react'
import { Pagination, Zoom, Navigation } from 'swiper/modules'
import { motion, AnimatePresence } from 'framer-motion'
import 'swiper/css'
import 'swiper/css/pagination'
import 'swiper/css/zoom'
import 'swiper/css/navigation'

// изображения из public/assets с учетом base path
const baseUrl = import.meta.env.BASE_URL
const berriesImage = `${baseUrl}assets/berries-category.jpg`
const neckImage = `${baseUrl}assets/neck-category.jpg`
const handsImage = `${baseUrl}assets/hands-category.jpg`
const earsImage = `${baseUrl}assets/ears-category.jpg`
const bakeryImage = `${baseUrl}assets/bakery-category.jpg`
const petsImage = `${baseUrl}assets/pets-category.jpg`
const certificateImage = `${baseUrl}assets/certificate-category.jpg`
const logoImage = `${baseUrl}assets/logo_.PNG`
const backgroundImage = `${baseUrl}assets/background.jpg`

// форматирование даты из YYYY-MM-DD в дд.мм.гггг
function formatDate(dateString: string): string {
  if (!dateString) return ''
  try {
    const [year, month, day] = dateString.split('-')
    if (year && month && day) {
      return `${day}.${month}.${year}`
    }
    return dateString
  } catch {
    return dateString
  }
}

type Category = {
  key: string
  title: string
  description?: string
  image: string
  image_position?: string // для background-position (например "50% 50%", "center")
  disabled?: boolean // если true, категория некликабельна
}

type Product = {
  slug: string
  title: string
  description?: string
  category: string
  price_rub: number
  discount_price_rub?: number // цена со скидкой (если заполнена - используется вместо price_rub)
  badge_text?: string // текст плашки (например, "СКИДКА", "НОВИНКА", "ПЕРСОНАЛИЗАЦИЯ")
  images: string[]
  active: boolean
  stock?: number
  article?: string // артикул товара
}

type CartItem = {
  slug: string
  quantity: number
}

// функция для получения актуальной цены товара (со скидкой если есть, иначе обычная)
function getProductPrice(product: Product): number {
  return product.discount_price_rub !== undefined && product.discount_price_rub > 0 
    ? product.discount_price_rub 
    : product.price_rub
}

// fallback категории (если API не отдаёт)
const defaultCategories: Category[] = [
  { key: 'ягоды', title: 'Ягоды (special)', description: 'Эксклюзивная коллекция KOSHEK, украшения в виде реалистичных ягод из полимерной глины', image: berriesImage },
  { key: 'выпечка', title: 'Выпечка', description: 'Эксклюзивная коллекция КОШЕК, украшения в виде реалистичной выпечки из полимерной глины', image: bakeryImage },
  { key: 'pets', title: 'FOR PETS', description: 'Украшения для ваших питомцев.', image: petsImage },
  { key: 'шея', title: 'Шея', description: 'Чокеры, колье, подвески, кулоны', image: neckImage },
  { key: 'руки', title: 'Руки', description: 'Браслеты, кольца', image: handsImage },
  { key: 'уши', title: 'Уши', description: 'Серьги, каффы', image: earsImage },
  { key: 'сертификаты', title: 'Сертификаты', image: certificateImage },
]

const ImageWithLoader = ({ src, alt }: { src: string, alt: string }) => {
  const { loading, error } = useImageLoader(src)

  if (error) {
    return (
      <div className="product-card__image product-card__image--placeholder">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M21.25 10.86v7.51c0 1.9-1.53 3.43-3.43 3.43H6.18c-1.9 0-3.43-1.53-3.43-3.43V6.63c0-1.9 1.53-3.43 3.43-3.43h7.51" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M17.82 2.29 11.19 9.89c-.38.44-.32 1.11.12 1.49l1.45 1.27c.42.36 1.05.36 1.47 0l6.63-7.6c.6-.7-.04-1.84-0.89-1.74l-8.6 1.15c-.52.07-.88.58-.73 1.08l.18.61" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M6.88 14.13a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8Z" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    )
  }

  return (
    <div
      className={`product-card__image ${loading ? 'shimmer-bg' : 'fade-in-image'}`}
      style={loading ? {} : { backgroundImage: `url(${src})` }}
    />
  )
}

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

// получаем username менеджера из переменных окружения
const getSupportUsername = () => {
  return import.meta.env.VITE_SUPPORT_USERNAME || 'koshekmanager'
}

// компонент для кликабельной ссылки на менеджера
const ManagerLink = ({ children }: { children: React.ReactNode }) => {
  const username = getSupportUsername()
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    window.open(`https://t.me/${username.replace('@', '')}`, '_blank')
  }
  return (
    <a href={`https://t.me/${username.replace('@', '')}`} onClick={handleClick} className="manager-link">
      {children}
    </a>
  )
}

const AboutUsModal = ({ onClose }: { onClose: () => void }) => {
  return (
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
        <AccordionItem question="Условия возврата товара и денежных средств">
          <p>— Возврат товара надлежащего качества возможен в течение 14 дней с момента получения заказа.</p>
          <p>— Товар должен быть в оригинальном виде, с бирками, без следов использования, в оригинальной упаковке.</p>
          <p>— Возврат денежных средств осуществляется на ту же карту, с которой была произведена оплата, в течение 10 рабочих дней.</p>
          <p>— При обнаружении брака или несоответствия описанию товар можно вернуть в течение гарантийного срока.</p>
          <p>— Для оформления возврата свяжитесь с <ManagerLink>менеджером</ManagerLink></p>
        </AccordionItem>
      </div>
    </div>
  )
}

const FullscreenImage = ({ 
  images,
  currentIndex,
  onClose,
  onNavigate
}: { 
  images: string[]
  currentIndex: number
  onClose: () => void
  onNavigate: (newIndex: number) => void
}) => {
  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation()
    onClose()
  }

  return (
    <div className="fullscreen-image" onClick={onClose}>
      <button className="fullscreen-image__close" onClick={handleClose}>&times;</button>
      
      <Swiper
        modules={[Pagination, Zoom]}
        pagination={{ clickable: true }}
        zoom={true}
        initialSlide={currentIndex}
        onSlideChange={(swiper: SwiperClass) => onNavigate(swiper.activeIndex)}
      >
        {images.map((img, idx) => (
          <SwiperSlide key={idx} onClick={(e) => e.stopPropagation()}>
            <div className="swiper-zoom-container">
              <img src={img} alt={`Товар (фото ${idx + 1})`} />
            </div>
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  )
}

const ProductModal = ({ 
  product, 
  cart, 
  onAddToCart, 
  onClose,
  onAddedToCart,
  ordersClosed,
  onOrdersClosedClick
}: { 
  product: Product
  cart: CartItem[]
  onAddToCart: (slug: string, quantity: number) => void
  onClose: () => void
  onAddedToCart: () => void
  ordersClosed: boolean
  onOrdersClosedClick: () => void
}) => {
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const [quantity, setQuantity] = useState(1)
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [addedState, setAddedState] = useState(false)
  const swiperRef = useRef<SwiperClass | null>(null)
  const { loading: mainImageLoading } = useImageLoader(
    product.images?.[selectedImageIndex] || ''
  )
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

  // синхронизация свайпера с выбранной миниатюрой
  useEffect(() => {
    if (swiperRef.current && swiperRef.current.activeIndex !== selectedImageIndex) {
      swiperRef.current.slideTo(selectedImageIndex)
    }
  }, [selectedImageIndex])

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
    if (canAddToCart && !isAdding) {
      setIsAdding(true)
      setTimeout(() => {
        onAddToCart(product.slug, quantity)
        setAddedState(true)
        setIsAdding(false)
        setTimeout(() => {
          onAddedToCart()
          setAddedState(false)
        }, 1000)
      }, 500)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--product" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        
        {/* фото-галерея */}
        {product.images && product.images.length > 0 && (
          <div className="product-modal__gallery">
            {product.badge_text && (
              <div className="product-modal__badge">
                {product.badge_text}
              </div>
            )}
            <Swiper
              modules={[Navigation]}
              navigation
              onSwiper={(swiper) => (swiperRef.current = swiper)}
              onSlideChange={(swiper) => setSelectedImageIndex(swiper.activeIndex)}
            >
              {product.images.map((img, idx) => (
                <SwiperSlide key={idx}>
                  <div 
                    className={`product-modal__image ${mainImageLoading && selectedImageIndex === idx ? 'shimmer-bg' : 'fade-in-image'}`}
                    style={
                      mainImageLoading && selectedImageIndex === idx
                        ? {} 
                        : { backgroundImage: `url(${img})` }
                    }
                    onClick={() => setFullscreenImage(img)}
                  />
                </SwiperSlide>
              ))}
            </Swiper>
            
            {product.images.length > 1 && (
              <div className="product-modal__thumbnails">
                {product.images.map((img, idx) => (
                  <ThumbnailButton
                    key={idx}
                    src={img}
                    isActive={selectedImageIndex === idx}
                    onClick={() => setSelectedImageIndex(idx)}
                    aria-label={`Фото ${idx + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        
        <div className="product-modal__info">
          <h2 className="product-modal__title">{product.title}</h2>
          <div className="product-modal__price">
            {product.discount_price_rub !== undefined && product.discount_price_rub > 0 ? (
              <>
                <span className="product-modal__price-old">{product.price_rub} ₽</span>
                <span className="product-modal__price-new">{product.discount_price_rub} ₽</span>
              </>
            ) : (
              <span>{product.price_rub} ₽</span>
            )}
          </div>
          {product.article && (
            <p className="product-modal__article">Арт. {product.article}</p>
          )}
          
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
              className={`btn btn--add-to-cart ${addedState ? 'added' : ''}`}
              onClick={handleAddToCart}
              disabled={!canAddToCart || isAdding || addedState}
            >
              {isAdding ? 'Добавляем...' : addedState ? 'Добавлено ✓' : 'Добавить в корзину'}
            </button>
          </div>
        </div>
      </div>
      {fullscreenImage && (
        <FullscreenImage 
          images={product.images}
          currentIndex={selectedImageIndex}
          onClose={() => setFullscreenImage(null)}
          onNavigate={(newIndex) => {
            setSelectedImageIndex(newIndex)
            setFullscreenImage(product.images[newIndex])
          }}
        />
      )}
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

// модальное окно с информацией о необходимости зайти через Telegram
const TelegramRequiredModal = ({ 
  onClose
}: { 
  onClose: () => void
}) => {
  const botUsername = import.meta.env.VITE_BOT_USERNAME || 'koshekjewerlybot'
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--success" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <div className="order-success">
          <div className="order-success__icon order-success__icon--telegram">📱</div>
          <h2 className="order-success__title">Заказ через Telegram</h2>
          <p className="order-success__text">
            Для оформления заказа необходимо зайти через Telegram бота.
          </p>
          <p className="order-success__text" style={{ marginTop: '16px' }}>
            Перейдите в бота: <strong>@{botUsername}</strong>
          </p>
          <button className="btn order-success__button order-success__button--pink" onClick={onClose} style={{ marginTop: '24px' }}>
            Понятно
          </button>
        </div>
      </div>
    </div>
  )
}

// модальное окно с информацией о закрытых заказах
const OrdersClosedModal = ({ 
  closeDate,
  onClose 
}: { 
  closeDate?: string
  onClose: () => void 
}) => {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--success" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <div className="order-success">
          <div className="order-success__icon" style={{ background: '#ff9800' }}>💡</div>
          <h2 className="order-success__title">Заказы временно закрыты</h2>
          <p className="order-success__text">
            Заказы временно не принимаются{closeDate ? ` до ${formatDate(closeDate)}` : ''}, но каталог по-прежнему доступен для просмотра.
          </p>
          <button className="btn btn--primary order-success__button" onClick={onClose}>
            Понятно
          </button>
        </div>
      </div>
    </div>
  )
}

// модальное окно перед перенаправлением на оплату
const PaymentRedirectModal = ({ 
  onConfirm,
  onCancel
}: { 
  onConfirm: () => void
  onCancel: () => void
}) => {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content modal-content--success" onClick={e => e.stopPropagation()}>
        <button className="modal-close modal-close--payment" onClick={onCancel}>&times;</button>
        <div className="order-success">
          <div className="order-success__icon order-success__icon--payment">💳</div>
          <h2 className="order-success__title">Переход к оплате</h2>
          <p className="order-success__text">
            Вы будете перенаправлены на сайт платежной системы.<br/><br/>
            Сразу после оплаты бот отправит Вам информацию о заказе в сообщениях.
          </p>
          <button className="btn order-success__button order-success__button--pink" onClick={onConfirm} style={{ marginTop: '24px' }}>
            Подтвердить
          </button>
        </div>
      </div>
    </div>
  )
}

const OrderSuccessModal = ({ 
  orderId, 
  paymentStatus,
  onClose 
}: { 
  orderId?: string
  paymentStatus?: 'success' | 'fail' | null
  onClose: () => void 
}) => {
  const isSuccess = paymentStatus !== 'fail'
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--success" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <div className="order-success">
          {isSuccess ? (
            <>
              <div className="order-success__icon">✓</div>
              <h2 className="order-success__title">Оплата успешна!</h2>
              <p className="order-success__text">
                Спасибо за Ваш заказ! Информация отправлена Вам в Telegram, а также нашему менеджеру.
              </p>
              {orderId && (
                <p className="order-success__id">Номер заказа: {orderId}</p>
              )}
            </>
          ) : (
            <>
              <div className="order-success__icon" style={{ background: '#d32f2f' }}>✕</div>
              <h2 className="order-success__title">Оплата не завершена</h2>
              <p className="order-success__text">
                К сожалению, произошла ошибка при оплате заказа. Попробуйте оформить заказ еще раз.
              </p>
              {orderId && (
                <p className="order-success__id">Номер заказа: {orderId}</p>
              )}
            </>
          )}
          <button className="btn btn--primary order-success__button" onClick={onClose}>
            Понятно
          </button>
        </div>
      </div>
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
      <h3 className="delivery-region-selector__title">Куда отправляем?</h3>
      <div className="delivery-region-selector__grid">
        {Object.entries(DELIVERY_LABELS).map(([key, label]) => (
          <button
            key={key}
            className="delivery-region-selector__option"
            onClick={() => onSelect(key as DeliveryRegion)}
          >
            <span className="delivery-region-selector__label">{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// получаем slug тестового товара из переменных окружения
const getTestProductSlug = () => {
  const slug = import.meta.env.VITE_TEST_PRODUCT_SLUG || ''
  // детальное логирование для отладки
  console.log('[getTestProductSlug] все env переменные:', {
    VITE_TEST_PRODUCT_SLUG: import.meta.env.VITE_TEST_PRODUCT_SLUG,
    VITE_API_URL: import.meta.env.VITE_API_URL,
    BASE_URL: import.meta.env.BASE_URL,
    MODE: import.meta.env.MODE,
    PROD: import.meta.env.PROD,
    DEV: import.meta.env.DEV
  })
  console.log('[getTestProductSlug] результат:', slug)
  return slug
}

// проверяем, является ли товар тестовым
const isTestProduct = (slug: string): boolean => {
  const testSlug = getTestProductSlug()
  return testSlug && slug === testSlug
}

// проверяем, содержит ли корзина только тестовые товары
const isCartOnlyTestProducts = (cart: CartItem[], products: Product[]): boolean => {
  if (cart.length === 0) {
    console.log('[isCartOnlyTestProducts] корзина пуста')
    return false
  }
  
  const testSlug = getTestProductSlug()
  console.log('[isCartOnlyTestProducts] testSlug из env:', testSlug)
  
  if (!testSlug) {
    console.log('[isCartOnlyTestProducts] тестовый товар не задан, считаем что все обычные')
    return false // если не задан тестовый товар, считаем что все обычные
  }
  
  // проверяем что все товары в корзине - тестовые
  const cartItems = cart.map(item => {
    const product = products.find(p => p.slug === item.slug)
    const isTest = product ? isTestProduct(product.slug) : false
    console.log('[isCartOnlyTestProducts] товар:', {
      slug: item.slug,
      found: !!product,
      isTest,
      testSlug
    })
    return { item, product, isTest }
  })
  
  const allTest = cartItems.every(({ isTest }) => isTest)
  console.log('[isCartOnlyTestProducts] результат:', {
    cartLength: cart.length,
    allTest,
    items: cartItems.map(({ item, isTest }) => ({ slug: item.slug, isTest }))
  })
  
  return allTest
}

// компонент формы оформления заказа
const CheckoutForm = ({
  deliveryRegion,
  cartTotal,
  cart,
  products,
  onBack,
  onSubmit
}: {
  deliveryRegion: DeliveryRegion
  cartTotal: number
  cart: CartItem[]
  products: Product[]
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
  const [promocode, setPromocode] = useState('')
  const [promocodeStatus, setPromocodeStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid' | 'not_found'>('idle')
  const [promocodeDiscount, setPromocodeDiscount] = useState(0)
  const [promocodeInfo, setPromocodeInfo] = useState<{ type: 'amount' | 'percent'; value: number } | null>(null)
  const [priorityOrder, setPriorityOrder] = useState(false)
  const [priorityToastOpen, setPriorityToastOpen] = useState(false)
  const priorityAnchorRef = useRef<HTMLDivElement>(null)
  const [priorityToastPos, setPriorityToastPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!priorityToastOpen) {
      setPriorityToastPos(null)
      return
    }
    const measure = () => {
      const el = priorityAnchorRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const maxW = 260
      let left = r.left
      if (left + maxW > window.innerWidth - 12) {
        left = Math.max(8, window.innerWidth - maxW - 12)
      }
      setPriorityToastPos({ top: r.bottom + 8, left })
    }
    const id = requestAnimationFrame(() => requestAnimationFrame(measure))
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [priorityToastOpen])

  // получаем username из Telegram
  useEffect(() => {
    try {
      const tgUser = WebApp.initDataUnsafe?.user
      if (tgUser?.username) {
        setFormData(prev => ({ ...prev, username: `@${tgUser.username}` }))
      }
    } catch {}
  }, [])

  // регистрируем пользователя при открытии мини-аппа (для рассылки)
  useEffect(() => {
    const initData = WebApp.initData
    if (!initData) return
    const apiUrl = import.meta.env.VITE_API_URL || ''
    fetch(`${apiUrl}/api/register-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData, platform: appPlatform })
    }).catch(() => {}) // fire and forget, ошибки не критичны
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
  // если в корзине только тестовые товары - доставка бесплатная
  const isOnlyTestProducts = isCartOnlyTestProducts(cart, products)
  const deliveryCost = isOnlyTestProducts ? 0 : DELIVERY_COSTS[deliveryRegion]
  const subtotal = cartTotal + deliveryCost
  const subtotalAfterDiscount = Math.max(0, subtotal - promocodeDiscount)
  const priorityFee =
    priorityOrder && subtotalAfterDiscount > 0
      ? Math.round(subtotalAfterDiscount * 0.3)
      : 0
  const total = subtotalAfterDiscount + priorityFee
  
  console.log('[CheckoutForm] расчет доставки:', {
    cartLength: cart.length,
    isOnlyTestProducts,
    deliveryRegion,
    deliveryCost,
    cartTotal,
    total,
    testSlug: getTestProductSlug()
  })

  const validate = () => {
    const newErrors: Record<string, string> = {}
    
    if (!formData.fullName.trim()) {
      newErrors.fullName = 'Обязательное поле'
    } else if (formData.fullName.length > 100) {
      newErrors.fullName = 'Максимум 100 символов'
    }
    
    if (!formData.phone.trim()) {
      newErrors.phone = 'Обязательное поле'
    } else if (!/^[\d\s\-\+\(\)]+$/.test(formData.phone)) {
      newErrors.phone = 'Некорректный номер телефона'
    } else {
      const digits = formData.phone.replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 12) {
        newErrors.phone = 'Номер должен содержать 10–12 цифр'
      }
    }
    
    if (!formData.country.trim()) {
      newErrors.country = 'Обязательное поле'
    } else if (formData.country.length > 50) {
      newErrors.country = 'Максимум 50 символов'
    }
    
    if (!formData.city.trim()) {
      newErrors.city = 'Обязательное поле'
    } else if (formData.city.length > 50) {
      newErrors.city = 'Максимум 50 символов'
    }
    
    if (!formData.address.trim()) {
      newErrors.address = 'Обязательное поле'
    } else if (formData.address.length > 200) {
      newErrors.address = 'Максимум 200 символов'
    }
    
    if (formData.comments && formData.comments.length > 500) {
      newErrors.comments = 'Максимум 500 символов'
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
        total,
        priorityOrder,
        promocode: promocodeStatus === 'valid' ? promocode.trim().toUpperCase() : undefined
      })
    }
  }

  const handleChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  const handlePromocodeApply = async () => {
    if (!promocode.trim()) {
      setPromocodeStatus('idle')
      setPromocodeDiscount(0)
      setPromocodeInfo(null)
      return
    }

    setPromocodeStatus('checking')
    try {
      const apiUrl = import.meta.env.VITE_API_URL || '/api'
      const currentSubtotal = cartTotal + deliveryCost
      // получаем slug'и товаров из корзины для проверки привязки промокода
      const orderItemSlugs = cart.map(item => item.slug)
      const response = await fetch(`${apiUrl}/api/promocodes/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: promocode.trim().toUpperCase(),
          orderTotal: currentSubtotal,
          orderItemSlugs
        })
      })

      const data = await response.json()

      if (data.valid && data.discount) {
        setPromocodeStatus('valid')
        setPromocodeDiscount(data.discount)
        setPromocodeInfo({ type: data.type, value: data.value })
      } else {
        // различаем ошибки: не найден или недействителен
        setPromocodeStatus(data.error === 'not_found' ? 'not_found' : 'invalid')
        setPromocodeDiscount(0)
        setPromocodeInfo(null)
      }
    } catch (error) {
      setPromocodeStatus('invalid')
      setPromocodeDiscount(0)
      setPromocodeInfo(null)
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
            maxLength={100}
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
            maxLength={20}
          />
          {errors.phone && <span className="checkout-form__error">{errors.phone}</span>}
        </label>

        {appPlatform !== 'max' && (
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
        )}

        <label className="checkout-form__label">
          Страна <span className="checkout-form__required">*</span>
          <input
            type="text"
            className={`checkout-form__input ${errors.country ? 'error' : ''}`}
            value={formData.country}
            onChange={(e) => handleChange('country', e.target.value)}
            placeholder={isEurope ? "Country" : "Россия"}
            maxLength={50}
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
            maxLength={50}
          />
          {errors.city && <span className="checkout-form__error">{errors.city}</span>}
        </label>

        <label className="checkout-form__label">
          {isEurope ? 'Домашний адрес' : 'СДЭК'} <span className="checkout-form__required">*</span>
          <input
            type="text"
            className={`checkout-form__input ${errors.address ? 'error' : ''}`}
            value={formData.address}
            onChange={(e) => handleChange('address', e.target.value)}
            placeholder={isEurope ? "Street, Building, Apartment" : "Адрес пункта выдачи СДЭК"}
            maxLength={200}
          />
          <span className="checkout-form__char-count">{formData.address.length}/200</span>
          {errors.address && <span className="checkout-form__error">{errors.address}</span>}
        </label>

        <label className="checkout-form__label">
          Промокод
          <div className="checkout-form__promocode">
            <input
              type="text"
              className={`checkout-form__input checkout-form__promocode-input ${(promocodeStatus === 'invalid' || promocodeStatus === 'not_found') ? 'error' : ''}`}
              value={promocode}
              onChange={(e) => {
                setPromocode(e.target.value.toUpperCase())
                if (promocodeStatus !== 'idle') {
                  setPromocodeStatus('idle')
                  setPromocodeDiscount(0)
                  setPromocodeInfo(null)
                }
              }}
              placeholder="Введите промокод"
              maxLength={50}
            />
            <button
              type="button"
              className="checkout-form__promocode-btn"
              onClick={handlePromocodeApply}
              disabled={promocodeStatus === 'checking' || !promocode.trim()}
            >
              {promocodeStatus === 'checking' ? '...' : '✓'}
            </button>
          </div>
          {promocodeStatus === 'valid' && (
            <span className="checkout-form__promocode-message checkout-form__promocode-message--success">
              Промокод активирован
            </span>
          )}
          {promocodeStatus === 'not_found' && (
            <span className="checkout-form__promocode-message checkout-form__promocode-message--error">
              Промокод не найден
            </span>
          )}
          {promocodeStatus === 'invalid' && (
            <span className="checkout-form__promocode-message checkout-form__promocode-message--error">
              Промокод недействителен
            </span>
          )}
        </label>

        <label className="checkout-form__label">
          Комментарии
          <textarea
            className={`checkout-form__textarea ${errors.comments ? 'error' : ''}`}
            value={formData.comments}
            onChange={(e) => handleChange('comments', e.target.value)}
            placeholder={isEurope ? "Additional comments" : "Дополнительная информация к заказу"}
            rows={3}
            maxLength={500}
          />
          <span className="checkout-form__char-count">{formData.comments.length}/500</span>
          {errors.comments && <span className="checkout-form__error">{errors.comments}</span>}
        </label>

        <div className="checkout-form__priority-wrap" ref={priorityAnchorRef}>
          <div className="checkout-form__priority">
            <div className="checkout-form__priority-row">
              <span className="checkout-form__priority-label">Приоритетный заказ</span>
              <button
                type="button"
                role="switch"
                aria-checked={priorityOrder}
                className={`checkout-form__switch ${priorityOrder ? 'checkout-form__switch--on' : ''}`}
                onClick={() => {
                  setPriorityOrder((prev) => {
                    const next = !prev
                    if (next) {
                      queueMicrotask(() => setPriorityToastOpen(true))
                    } else {
                      setPriorityToastOpen(false)
                    }
                    return next
                  })
                }}
              >
                <span className="checkout-form__switch-thumb" />
              </button>
            </div>
          </div>

          {priorityToastOpen && priorityToastPos && (
            <>
              <div
                className="priority-toast-backdrop"
                role="presentation"
                aria-hidden="true"
                onClick={() => setPriorityToastOpen(false)}
                onTouchEnd={() => setPriorityToastOpen(false)}
              />
              <div
                className="priority-toast-anchor"
                role="dialog"
                aria-live="polite"
                style={{ top: priorityToastPos.top, left: priorityToastPos.left }}
                onClick={() => setPriorityToastOpen(false)}
                onTouchEnd={() => setPriorityToastOpen(false)}
              >
                <p className="priority-toast__text">
                  Приоритетный заказ оформляется вне очереди и отправляется в течение 24 часов.
                  <br />
                  Стоимость услуги +30% к общей сумме заказа.
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="checkout-form__summary">
        <div className="checkout-form__summary-row">
          <span>Товары:</span>
          <span>{cartTotal} ₽</span>
        </div>
        <div className="checkout-form__summary-row">
          <span>Доставка ({DELIVERY_LABELS[deliveryRegion]}):</span>
          <span>{isOnlyTestProducts ? 'Бесплатно' : `${deliveryCost} ₽`}</span>
        </div>
        {promocodeStatus === 'valid' && promocodeDiscount > 0 && (
          <div className="checkout-form__summary-row checkout-form__summary-row--discount">
            <span>
              Скидка {promocodeInfo?.type === 'percent' ? `(${promocodeInfo.value}%)` : ''}:
            </span>
            <span>-{promocodeDiscount} ₽</span>
          </div>
        )}
        {priorityOrder && priorityFee > 0 && (
          <div className="checkout-form__summary-row checkout-form__summary-row--priority">
            <span>Приоритетный заказ (+30%):</span>
            <span>{priorityFee} ₽</span>
          </div>
        )}
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

  const total = cartItems.reduce((sum, item) => sum + getProductPrice(item) * item.quantity, 0)

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
                      <p className="cart-item__price">{getProductPrice(item)} ₽ × {item.quantity}</p>
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

// хук для предзагрузки изображения
function useImagePreload(src: string) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!src) return
    
    const img = new Image()
    img.src = src
    img.onload = () => setLoaded(true)
    img.onerror = () => {
      setError(true)
      setLoaded(true) // показываем даже при ошибке
    }

    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [src])

  return { loaded, error }
}

// хук для отслеживания загрузки изображений в модалке
function useImageLoader(src: string) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    setLoading(true)
    setError(false)
    
    if (!src) {
      setError(true)
      setLoading(false)
      return
    }
    
    const img = new Image()
    img.src = src
    img.onload = () => setLoading(false)
    img.onerror = () => {
      setError(true)
      setLoading(false)
    }
  }, [src])

  return { loading, error }
}

// нормализуем background-position: старые некорректные значения (623.5% и т.п.) → center
function normalizeBgPosition(pos: string | undefined): string {
  if (!pos || pos === 'center') return 'center'
  const m = pos.match(/(\d+(?:\.\d+)?)\s*%\s+(\d+(?:\.\d+)?)\s*%/)
  if (!m) return 'center'
  const x = parseFloat(m[1])
  const y = parseFloat(m[2])
  if (x < 0 || x > 100 || y < 0 || y > 100) return 'center'
  return `${x}% ${y}%`
}

// компонент категории с предзагрузкой изображения
const CategoryCard = ({ card, onSelect }: { card: Category, onSelect: () => void }) => {
  const { loaded } = useImagePreload(card.image || '')
  const bgPosition = normalizeBgPosition(card.image_position)
  const hasImage = !!card.image
  
  return (
    <button
      key={card.key}
      className={`category-card ${hasImage && loaded ? 'image-loaded' : ''} ${card.disabled ? 'category-card--disabled' : ''}`}
      onClick={card.disabled ? undefined : onSelect}
      disabled={card.disabled}
    >
      <div className="category-card__media" style={{ backgroundImage: hasImage ? `url(${card.image})` : undefined, backgroundPosition: bgPosition }} />
      <div className="category-card__overlay" />
      <div className="category-card__content">
        <h2 className="category-card__title">{card.title}</h2>
        {card.description && <p className="category-card__description">{card.description}</p>}
      </div>
    </button>
  )
}

const ThumbnailButton = ({ 
  src, 
  isActive, 
  onClick,
  'aria-label': ariaLabel
}: { 
  src: string
  isActive: boolean
  onClick: () => void
  'aria-label': string
}) => {
  const { loading } = useImageLoader(src)

  return (
    <button
      className={`product-modal__thumbnail ${isActive ? 'active' : ''} ${loading ? 'shimmer-bg' : 'fade-in-image'}`}
      onClick={onClick}
      style={loading ? {} : { backgroundImage: `url(${src})` }}
      aria-label={ariaLabel}
    />
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
  const [categories, setCategories] = useState<Category[]>(defaultCategories)
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [cart, setCart] = useState<CartItem[]>([])
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [orderSuccessOpen, setOrderSuccessOpen] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [paymentStatus, setPaymentStatus] = useState<'success' | 'fail' | null>(null)
  const [paymentRedirectOpen, setPaymentRedirectOpen] = useState(false)
  const [pendingPaymentUrl, setPendingPaymentUrl] = useState<string | null>(null)
  const [telegramRequiredOpen, setTelegramRequiredOpen] = useState(false)
  const [ordersClosed, setOrdersClosed] = useState(false)
  const [ordersCloseDate, setOrdersCloseDate] = useState<string | undefined>(undefined)
  const [ordersClosedModalOpen, setOrdersClosedModalOpen] = useState(false)
  const mainContentRef = useRef<HTMLElement>(null)
  const productsTitleRef = useRef<HTMLHeadingElement>(null)
  
  // предзагрузка фонового изображения
  const { loaded: headerImageLoaded } = useImagePreload(backgroundImage)
  const { loaded: logoImageLoaded } = useImagePreload(logoImage)
  
  // обработка возврата после оплаты
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const orderIdFromUrl = urlParams.get('orderId')
    const path = window.location.pathname
    
    // если вернулись со страницы успешной оплаты
    if (path.includes('/payment/success') && orderIdFromUrl) {
      setOrderId(orderIdFromUrl)
      setPaymentStatus('success')
      setOrderSuccessOpen(true)
      // очищаем URL
      window.history.replaceState({}, '', window.location.pathname)
    }
    
    // если вернулись со страницы неудачной оплаты
    if (path.includes('/payment/fail') && orderIdFromUrl) {
      setOrderId(orderIdFromUrl)
      setPaymentStatus('fail')
      setOrderSuccessOpen(true)
      // очищаем URL
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  // загрузка категорий из API
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || '/api'
        const url = apiUrl.endsWith('/api') ? `${apiUrl}/categories` : `${apiUrl}/api/categories`
        const response = await fetch(url)
        if (response.ok) {
          const data = await response.json()
          const list = data.categories || []
          if (list.length > 0) {
            setCategories(list.map((c: { key: string; title: string; description?: string; image: string; image_position?: string }) => ({
              key: c.key,
              title: c.title,
              description: c.description,
              image: c.image,
              image_position: c.image_position || 'center'
            })))
          }
        }
      } catch {
        // оставляем defaultCategories
      }
    }
    loadCategories()
  }, [])

  // загрузка статуса заказов
  useEffect(() => {
    const loadOrdersStatus = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || '/api'
        const url = apiUrl.endsWith('/api') ? `${apiUrl}/settings/orders-status` : `${apiUrl}/api/settings/orders-status`
        console.log('[mini-app] загрузка статуса заказов из', url)
        const response = await fetch(url)
        if (response.ok) {
          const data = await response.json()
          console.log('[mini-app] получены настройки заказов:', data)
          setOrdersClosed(data.ordersClosed || false)
          setOrdersCloseDate(data.closeDate)
          console.log('[mini-app] ordersClosed установлен в:', data.ordersClosed || false)
        } else {
          console.error('[mini-app] ошибка ответа при загрузке статуса заказов:', response.status, response.statusText)
        }
      } catch (error) {
        console.error('[mini-app] ошибка загрузки статуса заказов:', error)
      }
    }
    loadOrdersStatus()
  }, [])

  // управление корзиной с проверкой stock и статуса заказов
  const updateCart = (slug: string, delta: number) => {
    console.log('[mini-app] updateCart вызван:', { slug, delta, ordersClosed })
    // проверка статуса заказов при добавлении товара (delta > 0)
    if (delta > 0 && ordersClosed) {
      console.log('[mini-app] заказы закрыты, показываем модальное окно')
      setOrdersClosedModalOpen(true)
      return
    }
    
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
    return sum + (product ? getProductPrice(product) * item.quantity : 0)
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

  // обработчик отмены перехода к оплате
  const handlePaymentCancel = () => {
    setPaymentRedirectOpen(false)
    setPendingPaymentUrl(null)
    // возвращаемся к оформлению заказа
    setCheckoutOpen(true)
  }

  useEffect(() => {
    const handleBackButtonClick = () => {
      if (telegramRequiredOpen) {
        setTelegramRequiredOpen(false)
      } else if (paymentRedirectOpen) {
        handlePaymentCancel()
      } else if (checkoutOpen) {
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
        mainContentRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }

    if (selectedProduct || cartOpen || aboutModalOpen || selectedCategory || checkoutOpen || paymentRedirectOpen || telegramRequiredOpen) {
      WebApp.BackButton.show()
      WebApp.BackButton.onClick(handleBackButtonClick)
    } else {
      WebApp.BackButton.hide()
    }

    if (selectedProduct || cartOpen || aboutModalOpen || checkoutOpen || paymentRedirectOpen || telegramRequiredOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = 'unset'
    }

    return () => {
      WebApp.BackButton.offClick(handleBackButtonClick)
      document.body.style.overflow = 'unset'
    }
  }, [selectedProduct, cartOpen, aboutModalOpen, selectedCategory, checkoutOpen, checkoutStep, paymentRedirectOpen, telegramRequiredOpen])

  // проверяем наличие валидного initData от платформы (Telegram или MAX)
  const hasValidInitData = (): boolean => {
    try {
      // MAX Bridge: проверяем initDataUnsafe напрямую (user.id доступен без URL-декодинга)
      if (appPlatform === 'max') {
        const user = WebApp.initDataUnsafe?.user
        return !!(user?.id)
      }

      // Telegram: стандартная проверка через URL-encoded initData
      const initData = WebApp.initData || ''
      if (!initData) return false
      const params = new URLSearchParams(initData)
      const userParam = params.get('user')
      if (!userParam) return false
      try {
        const user = JSON.parse(userParam)
        return !!(user?.id)
      } catch {
        return false
      }
    } catch {
      return false
    }
  }

  const handleCheckoutStart = () => {
    // проверяем наличие валидного initData
    if (!hasValidInitData()) {
      setCartOpen(false)
      setTelegramRequiredOpen(true)
      return
    }
    
    setCartOpen(false)
    setCheckoutOpen(true)
    setCheckoutStep('region')
    setDeliveryRegion(null)
  }

  // обработчик подтверждения перехода к оплате
  const handlePaymentConfirm = () => {
    if (pendingPaymentUrl) {
      setPaymentRedirectOpen(false)
      setCart([])
      // используем Telegram WebApp API для открытия внешней ссылки
      // это позволяет вернуться назад в приложение
      try {
        WebApp.openLink(pendingPaymentUrl)
      } catch (e) {
        // fallback если WebApp API недоступен
        console.warn('WebApp.openLink недоступен, используем window.open')
        window.open(pendingPaymentUrl, '_blank')
      }
      setPendingPaymentUrl(null)
    }
  }

  const handleDeliveryRegionSelect = (region: DeliveryRegion) => {
    setDeliveryRegion(region)
    setCheckoutStep('form')
  }

  const handleCheckoutSubmit = async (data: any) => {
    try {
      // собираем данные заказа с товарами из корзины
      const orderItems = cart.map(item => {
        const product = products.find(p => p.slug === item.slug)
        return product ? {
          slug: product.slug,
          title: product.title,
          price: getProductPrice(product),
          quantity: item.quantity
        } : null
      }).filter(Boolean)

      // получаем initData из Telegram для отправки сообщения покупателю
      let initData = ''
      try {
        initData = WebApp.initData || ''
      } catch {}

      const orderData = {
        ...data,
        items: orderItems,
        initData, // передаем initData для проверки подписи и получения chat_id
        platform: appPlatform // telegram или max — для выбора транспорта уведомлений
      }

      const apiUrl = import.meta.env.VITE_API_URL || '/api'
      const response = await fetch(`${apiUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData)
      })

      if (!response.ok) {
        throw new Error('Ошибка оформления заказа')
      }

      const result = await response.json()
      
      // если есть URL оплаты, показываем информационное окно перед редиректом
      if (result.paymentUrl) {
        setPendingPaymentUrl(result.paymentUrl)
        setCheckoutOpen(false)
        setPaymentRedirectOpen(true)
      } else {
        // если оплата не требуется (на всякий случай fallback)
        setOrderId(result.orderId || null)
        setCheckoutOpen(false)
        setOrderSuccessOpen(true)
        setCart([])
      }
    } catch (error) {
      console.error('Ошибка оформления заказа:', error)
      alert('Произошла ошибка при оформлении заказа. Попробуйте еще раз.')
    }
  }


  // фильтруем товары по категории
  const filteredProducts = selectedCategory
    ? products.filter(p => p.category === selectedCategory)
    : products

  const pageVariants = {
    initial: { opacity: 0, y: 20 },
    in: { opacity: 1, y: 0 },
    out: { opacity: 0, y: -20 },
  }

  const gridVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        when: "beforeChildren",
        staggerChildren: 0.1,
      },
    },
  }

  const itemVariants = {
    hidden: { y: 20, opacity: 0 },
    visible: { y: 0, opacity: 1 },
  }

  return (
    <>
      <header className={`page-header ${headerImageLoaded ? 'image-loaded' : ''}`}>
        <div 
          className="page-header__background"
          style={{ backgroundImage: `url(${backgroundImage})` }}
        />
        <img src={logoImage} alt="KOSHEK logo" className={`header-logo ${logoImageLoaded ? 'image-loaded' : ''}`} />
        <h1 className="page-header__title">KOSHEK</h1>
        <p className="page-header__text">Girls выбирают KOSHEK и бриллианты.</p>
        {ordersClosed && (
          <div className="page-header__orders-closed">
            <p className="page-header__orders-closed-text">
              💡 Заказы временно не принимаются{ordersCloseDate ? ` до ${formatDate(ordersCloseDate)}` : ''}, но каталог по-прежнему доступен для просмотра.
            </p>
          </div>
        )}
        <button
          className="scroll-down-btn"
          onClick={() => mainContentRef.current?.scrollIntoView({ behavior: 'smooth' })}
          aria-label="Scroll down"
        />
      </header>

      <main className="page" ref={mainContentRef}>
        <AnimatePresence mode="wait">
          {!selectedCategory ? (
            // сетка категорий
            <motion.section
              key="categories"
              className="category-grid"
              variants={pageVariants}
              initial="initial"
              animate="in"
              exit="out"
              transition={{ duration: 0.3 }}
            >
              {categories.map(card => (
                <CategoryCard
                  key={card.key}
                  card={card}
                  onSelect={() => setSelectedCategory(card.key)}
                />
              ))}
            </motion.section>
          ) : (
            // грид товаров выбранной категории
            <motion.section
              key="products"
              className="products-section"
              variants={pageVariants}
              initial="initial"
              animate="in"
              exit="out"
              transition={{ duration: 0.3 }}
              onAnimationComplete={() => {
                productsTitleRef.current?.scrollIntoView({ behavior: 'smooth' })
              }}
            >
              <h2 ref={productsTitleRef} className="products-section__title">
                {categories.find(c => c.key === selectedCategory)?.title}
              </h2>
              {loading ? (
                <p className="products-loading">Загрузка...</p>
              ) : filteredProducts.length === 0 ? (
                <p className="products-empty">Товары скоро появятся</p>
              ) : (
                <motion.div
                  className="products-grid"
                  variants={gridVariants}
                  initial="hidden"
                  animate="visible"
                >
                  {filteredProducts.map(product => (
                    <motion.div
                      key={product.slug}
                      className="product-card"
                      onClick={() => setSelectedProduct(product)}
                      variants={itemVariants}
                    >
                      <div className="product-card__image-wrapper">
                        <ImageWithLoader
                          src={product.images && product.images.length > 0 ? product.images[0] : ''}
                          alt={product.title}
                        />
                        {product.badge_text && (
                          <div className="product-card__badge">
                            {product.badge_text}
                          </div>
                        )}
                      </div>
                      <div className="product-card__info">
                        <h3 className="product-card__title">{product.title}</h3>
                        <div className="product-card__price">
                          {product.discount_price_rub !== undefined && product.discount_price_rub > 0 ? (
                            <>
                              <span className="product-card__price-old">{product.price_rub} ₽</span>
                              <span className="product-card__price-new">{product.discount_price_rub} ₽</span>
                            </>
                          ) : (
                            <span>{product.price_rub} ₽</span>
                          )}
                        </div>
          </div>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </motion.section>
          )}
        </AnimatePresence>

        <footer className="page-footer">
          <button className="btn-text" onClick={() => {
            const username = getSupportUsername()
            window.open(`https://t.me/${username.replace('@', '')}`, '_blank')
          }}>Поддержка</button>
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
          ordersClosed={ordersClosed}
          onOrdersClosedClick={() => setOrdersClosedModalOpen(true)}
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
                cart={cart}
                products={products}
                onBack={() => setCheckoutStep('region')}
                onSubmit={handleCheckoutSubmit}
              />
            )}
          </div>
          </div>
      )}
      
          {telegramRequiredOpen && (
            <TelegramRequiredModal
              onClose={() => setTelegramRequiredOpen(false)}
            />
          )}
          
          {paymentRedirectOpen && (
            <PaymentRedirectModal
              onConfirm={handlePaymentConfirm}
              onCancel={handlePaymentCancel}
            />
          )}
          
          {orderSuccessOpen && (
            <OrderSuccessModal 
              orderId={orderId || undefined}
              paymentStatus={paymentStatus || undefined}
              onClose={() => {
                setOrderSuccessOpen(false)
                setPaymentStatus(null)
              }}
            />
          )}

          {ordersClosedModalOpen && (
            <OrdersClosedModal
              closeDate={ordersCloseDate}
              onClose={() => setOrdersClosedModalOpen(false)}
            />
          )}
        </>
      )
    }


