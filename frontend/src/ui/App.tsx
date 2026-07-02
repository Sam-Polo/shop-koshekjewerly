import { useEffect, useState, useRef } from 'react'
import WebApp, { platform as appPlatform } from '../platform/webApp'
import React from 'react'
import { Swiper, SwiperSlide, type SwiperClass } from 'swiper/react'
import { Pagination, Zoom, Navigation } from 'swiper/modules'
import { motion, AnimatePresence } from 'framer-motion'
import Constructor, { ConstructorDetailModal, type ConstructorComposite, type ConstructorDetailView, type JewelryType } from './Constructor'
import { COUNTRIES, type Country } from './countries'

const CONSTRUCTOR_CATEGORY_KEY = 'constructor'

// Перенаправляем старые URL Timeweb на Yandex Cloud — Sheets трогать не нужно
const OLD_IMG_BASE = 'https://s3.twcstorage.ru/koshekjewerly-s3-bucket'
const NEW_IMG_BASE = 'https://storage.yandexcloud.net/koshekjewerly'
function rewriteImageUrl(url: string): string {
  if (!url) return url
  return url.startsWith(OLD_IMG_BASE) ? NEW_IMG_BASE + url.slice(OLD_IMG_BASE.length) : url
}

// видео и фото лежат в одном списке images, тип определяется по расширению.
// см. docs/VIDEO_SUPPORT.md
const VIDEO_EXT = /\.(mp4|webm|mov)$/i
function isVideo(url: string): boolean {
  return !!url && VIDEO_EXT.test(url.split('?')[0])
}
// обложка/миниатюра — всегда самое раннее ФОТО (видео для обложки пропускаем)
function firstPhoto(images: string[]): string {
  return images.find(u => !isVideo(u)) ?? images[0] ?? ''
}

const TYPE_TITLES: Record<JewelryType, string> = {
  necklace: 'Колье',
  earrings: 'Серьги',
  bracelet: 'Браслет'
}
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
  coming_drop?: boolean
}

type RegularCartItem = {
  kind: 'regular'
  slug: string
  quantity: number
}

type ConstructorComponentRef = {
  id: string
  title: string
  description?: string
  /** главная (первая) фотография — для быстрой отрисовки миниатюры */
  image: string
  /** полная галерея для preview-карточки */
  images: string[]
  price: number
}

type CompositeCartItem = {
  kind: 'constructor'
  /** канонический id композита: composer-{type}-{baseId}-{sortedPendantIds} — для дедупликации в корзине */
  id: string
  type: JewelryType
  base: ConstructorComponentRef
  pendants: ConstructorComponentRef[]
  quantity: number
}

type CartItem = RegularCartItem | CompositeCartItem

function makeCompositeId(c: { type: JewelryType; base: { id: string }; pendants: { id: string }[] }): string {
  const sortedPendantIds = [...c.pendants.map(p => p.id)].sort()
  return `composer-${c.type}-${c.base.id}-${sortedPendantIds.join('-')}`
}

function compositeUnitPrice(c: CompositeCartItem): number {
  return c.base.price + c.pendants.reduce((s, p) => s + p.price, 0)
}

function compositeTitle(c: CompositeCartItem): string {
  const pendantTitles = c.pendants.map(p => p.title).join(', ')
  return `${TYPE_TITLES[c.type]} на заказ: ${c.base.title} + ${pendantTitles}`
}

// функция для получения актуальной цены товара (со скидкой если есть, иначе обычная)
function getProductPrice(product: Product): number {
  return product.discount_price_rub !== undefined && product.discount_price_rub > 0 
    ? product.discount_price_rub 
    : product.price_rub
}

// ретраи с экспоненциальным бэкоффом для read-only запросов к бэкенду.
// покрывает cold start Render (~15-30 с): 3 попытки + задержки 3/6/12 с = ~21 с ожидания.
// 4xx (кроме 429) — ошибка нашего запроса, ретраить бесполезно.
// НЕ используем для POST /api/orders — там дублирование недопустимо.
const FETCH_RETRY_DELAYS_MS = [3000, 6000, 12000]

async function fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= FETCH_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return res
      lastError = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastError = e
    }
    if (attempt < FETCH_RETRY_DELAYS_MS.length) {
      await new Promise<void>(r => setTimeout(r, FETCH_RETRY_DELAYS_MS[attempt]))
    }
  }
  throw lastError
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

// минималистичный плеер: autoplay, без звука, loop, без перемотки.
// единственный контрол — пауза/плей по тапу. Анимация-индикатор play показывается,
// пока видео не играет (до старта autoplay + после ручной паузы) — она же служит
// fallback'ом, если браузер заблокировал autoplay (iOS low-power). см. docs/VIDEO_SUPPORT.md
const VideoPlayer = ({ src, isActive, onFullscreen }: { src: string, isActive: boolean, onFullscreen?: () => void }) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [userPaused, setUserPaused] = useState(false)
  const [loadProgress, setLoadProgress] = useState(0)

  // прогресс буферизации: сколько видео уже докачалось (по buffered/duration)
  const handleProgress = () => {
    const v = videoRef.current
    if (!v || !v.duration || !isFinite(v.duration) || v.buffered.length === 0) return
    const end = v.buffered.end(v.buffered.length - 1)
    setLoadProgress(Math.min(100, (end / v.duration) * 100))
  }

  // играем только на активном слайде; при уходе со слайда — пауза и сброс ручной паузы,
  // чтобы при возврате видео снова автозапускалось
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (isActive && !userPaused) {
      v.play().catch(() => {/* autoplay заблокирован — индикатор остаётся как «тапни» */})
    } else {
      v.pause()
      if (!isActive && userPaused) setUserPaused(false)
    }
  }, [isActive, userPaused])

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation()
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play().catch(() => {})
      setUserPaused(false)
    } else {
      v.pause()
      setUserPaused(true)
    }
  }

  const handleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation()
    onFullscreen?.()
  }

  return (
    <div className="product-modal__video" onClick={togglePlay}>
      <video
        ref={videoRef}
        src={src}
        muted
        loop
        playsInline
        preload={isActive ? 'auto' : 'metadata'}
        autoPlay={isActive}
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onProgress={handleProgress}
        onLoadedMetadata={handleProgress}
        onTimeUpdate={handleProgress}
      />
      <div className={`product-modal__video-indicator ${playing ? 'is-hidden' : ''}`} aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <rect x="6" y="4" width="4.5" height="16" />
          <rect x="13.5" y="4" width="4.5" height="16" />
        </svg>
      </div>
      <div
        className={`product-modal__video-loadbar ${loadProgress >= 99.5 ? 'is-hidden' : ''}`}
        aria-hidden="true"
      >
        <div className="product-modal__video-loadbar-fill" style={{ width: `${loadProgress}%` }} />
      </div>
      {onFullscreen && (
        <button
          className="product-modal__video-fullscreen"
          onClick={handleFullscreen}
          aria-label="Открыть видео на весь экран"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
        </button>
      )}
    </div>
  )
}

// миниатюра видео: первый кадр (#t=0.1 подсказывает браузеру показать кадр) + бейдж play
const VideoThumbnail = ({
  src, isActive, onClick, 'aria-label': ariaLabel
}: {
  src: string, isActive: boolean, onClick: () => void, 'aria-label': string
}) => (
  <button
    className={`product-modal__thumbnail product-modal__thumbnail--video ${isActive ? 'active' : ''}`}
    onClick={onClick}
    aria-label={ariaLabel}
  >
    <video src={`${src}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} />
    <span className="product-modal__thumbnail-play" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 5v14l11-7L8 5z" />
      </svg>
    </span>
  </button>
)

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

/**
 * ВАЖНО — политика хранится в ДВУХ местах и редактируется синхронно в обоих:
 *   1) Google Doc — каноническая версия (ссылка указана в п. 12.3 текста ниже):
 *      https://docs.google.com/document/d/16xNZvefjNn_V-1wEYurPFFOw5VP5jkXvbtNa1P4mEAA/edit
 *   2) этот компонент PrivacyPolicyModal — копия для показа в модалке мини-аппа.
 * При ЛЮБОЙ правке политики обнови ОБА места, иначе документ и витрина разойдутся.
 */
const PrivacyPolicyModal = ({ onClose }: { onClose: () => void }) => {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content policy-modal" onClick={e => e.stopPropagation()}>
        <button type="button" className="policy-modal__close" onClick={onClose} aria-label="Закрыть">&times;</button>
        <h3>Политика в отношении обработки персональных данных</h3>

        <h4>1. Общие положения</h4>
        <p>Настоящая политика обработки персональных данных составлена в соответствии с требованиями Федерального закона от 27.07.2006 № 152-ФЗ «О персональных данных» (далее — Закон о персональных данных) и определяет порядок обработки персональных данных и меры по обеспечению безопасности персональных данных, предпринимаемые Силинская Олеся Станиславовна (далее — Оператор).</p>
        <p>1.1. Оператор ставит своей важнейшей целью и условием осуществления своей деятельности соблюдение прав и свобод человека и гражданина при обработке его персональных данных, в том числе защиты прав на неприкосновенность частной жизни, личную и семейную тайну.</p>
        <p>1.2. Настоящая политика Оператора в отношении обработки персональных данных (далее — Политика) применяется ко всей информации, которую Оператор может получить о посетителях веб-сайта https://t.me/KoshekJewerlyBot.</p>

        <h4>2. Основные понятия, используемые в Политике</h4>
        <p>2.1. Автоматизированная обработка персональных данных — обработка персональных данных с помощью средств вычислительной техники.</p>
        <p>2.2. Блокирование персональных данных — временное прекращение обработки персональных данных (за исключением случаев, если обработка необходима для уточнения персональных данных).</p>
        <p>2.3. Веб-сайт — совокупность графических и информационных материалов, а также программ для ЭВМ и баз данных, обеспечивающих их доступность в сети интернет по сетевому адресу https://t.me/KoshekJewerlyBot.</p>
        <p>2.4. Информационная система персональных данных — совокупность содержащихся в базах данных персональных данных и обеспечивающих их обработку информационных технологий и технических средств.</p>
        <p>2.5. Обезличивание персональных данных — действия, в результате которых невозможно определить без использования дополнительной информации принадлежность персональных данных конкретному Пользователю или иному субъекту персональных данных.</p>
        <p>2.6. Обработка персональных данных — любое действие (операция) или совокупность действий (операций), совершаемых с использованием средств автоматизации или без использования таких средств с персональными данными, включая сбор, запись, систематизацию, накопление, хранение, уточнение (обновление, изменение), извлечение, использование, передачу (распространение, предоставление, доступ), обезличивание, блокирование, удаление, уничтожение персональных данных.</p>
        <p>2.7. Оператор — государственный орган, муниципальный орган, юридическое или физическое лицо, самостоятельно или совместно с другими лицами организующие и/или осуществляющие обработку персональных данных, а также определяющие цели обработки персональных данных, состав персональных данных, подлежащих обработке, действия (операции), совершаемые с персональными данными.</p>
        <p>2.8. Персональные данные — любая информация, относящаяся прямо или косвенно к определенному или определяемому Пользователю веб-сайта https://t.me/KoshekJewerlyBot.</p>
        <p>2.9. Персональные данные, разрешенные субъектом персональных данных для распространения, — персональные данные, доступ неограниченного круга лиц к которым предоставлен субъектом персональных данных путем дачи согласия на обработку персональных данных, разрешенных субъектом персональных данных для распространения в порядке, предусмотренном Законом о персональных данных (далее — персональные данные, разрешенные для распространения).</p>
        <p>2.10. Пользователь — любой посетитель веб-сайта https://t.me/KoshekJewerlyBot.</p>
        <p>2.11. Предоставление персональных данных — действия, направленные на раскрытие персональных данных определенному лицу или определенному кругу лиц.</p>
        <p>2.12. Распространение персональных данных — любые действия, направленные на раскрытие персональных данных неопределенному кругу лиц (передача персональных данных) или на ознакомление с персональными данными неограниченного круга лиц, в том числе обнародование персональных данных в средствах массовой информации, размещение в информационно-телекоммуникационных сетях или предоставление доступа к персональным данным каким-либо иным способом.</p>
        <p>2.13. Трансграничная передача персональных данных — передача персональных данных на территорию иностранного государства органу власти иностранного государства, иностранному физическому или иностранному юридическому лицу.</p>
        <p>2.14. Уничтожение персональных данных — любые действия, в результате которых персональные данные уничтожаются безвозвратно с невозможностью дальнейшего восстановления содержания персональных данных в информационной системе персональных данных и/или уничтожаются материальные носители персональных данных.</p>

        <h4>3. Основные права и обязанности Оператора</h4>
        <p>3.1. Оператор имеет право:</p>
        <p>— получать от субъекта персональных данных достоверные информацию и/или документы, содержащие персональные данные;</p>
        <p>— в случае отзыва субъектом персональных данных согласия на обработку персональных данных, а также направления обращения с требованием о прекращении обработки персональных данных, Оператор вправе продолжить обработку персональных данных без согласия субъекта персональных данных при наличии оснований, указанных в Законе о персональных данных;</p>
        <p>— самостоятельно определять состав и перечень мер, необходимых и достаточных для обеспечения выполнения обязанностей, предусмотренных Законом о персональных данных и принятыми в соответствии с ним нормативными правовыми актами, если иное не предусмотрено Законом о персональных данных или другими федеральными законами.</p>
        <p>3.2. Оператор обязан:</p>
        <p>— предоставлять субъекту персональных данных по его просьбе информацию, касающуюся обработки его персональных данных;</p>
        <p>— организовывать обработку персональных данных в порядке, установленном действующим законодательством РФ;</p>
        <p>— отвечать на обращения и запросы субъектов персональных данных и их законных представителей в соответствии с требованиями Закона о персональных данных;</p>
        <p>— сообщать в уполномоченный орган по защите прав субъектов персональных данных по запросу этого органа необходимую информацию в течение 10 дней с даты получения такого запроса;</p>
        <p>— публиковать или иным образом обеспечивать неограниченный доступ к настоящей Политике в отношении обработки персональных данных;</p>
        <p>— принимать правовые, организационные и технические меры для защиты персональных данных от неправомерного или случайного доступа к ним, уничтожения, изменения, блокирования, копирования, предоставления, распространения персональных данных, а также от иных неправомерных действий в отношении персональных данных;</p>
        <p>— прекратить передачу (распространение, предоставление, доступ) персональных данных, прекратить обработку и уничтожить персональные данные в порядке и случаях, предусмотренных Законом о персональных данных;</p>
        <p>— исполнять иные обязанности, предусмотренные Законом о персональных данных.</p>

        <h4>4. Основные права и обязанности субъектов персональных данных</h4>
        <p>4.1. Субъекты персональных данных имеют право:</p>
        <p>— получать информацию, касающуюся обработки его персональных данных, за исключением случаев, предусмотренных федеральными законами. Сведения предоставляются субъекту персональных данных Оператором в доступной форме, и в них не должны содержаться персональные данные, относящиеся к другим субъектам персональных данных, за исключением случаев, когда имеются законные основания для раскрытия таких персональных данных. Перечень информации и порядок ее получения установлен Законом о персональных данных;</p>
        <p>— требовать от оператора уточнения его персональных данных, их блокирования или уничтожения в случае, если персональные данные являются неполными, устаревшими, неточными, незаконно полученными или не являются необходимыми для заявленной цели обработки, а также принимать предусмотренные законом меры по защите своих прав;</p>
        <p>— выдвигать условие предварительного согласия при обработке персональных данных в целях продвижения на рынке товаров, работ и услуг;</p>
        <p>— на отзыв согласия на обработку персональных данных, а также на направление требования о прекращении обработки персональных данных;</p>
        <p>— обжаловать в уполномоченный орган по защите прав субъектов персональных данных или в судебном порядке неправомерные действия или бездействие Оператора при обработке его персональных данных;</p>
        <p>— на осуществление иных прав, предусмотренных законодательством РФ.</p>
        <p>4.2. Субъекты персональных данных обязаны:</p>
        <p>— предоставлять Оператору достоверные данные о себе;</p>
        <p>— сообщать Оператору об уточнении (обновлении, изменении) своих персональных данных.</p>
        <p>4.3. Лица, передавшие Оператору недостоверные сведения о себе, либо сведения о другом субъекте персональных данных без согласия последнего, несут ответственность в соответствии с законодательством РФ.</p>

        <h4>5. Принципы обработки персональных данных</h4>
        <p>5.1. Обработка персональных данных осуществляется на законной и справедливой основе.</p>
        <p>5.2. Обработка персональных данных ограничивается достижением конкретных, заранее определенных и законных целей. Не допускается обработка персональных данных, несовместимая с целями сбора персональных данных.</p>
        <p>5.3. Не допускается объединение баз данных, содержащих персональные данные, обработка которых осуществляется в целях, несовместимых между собой.</p>
        <p>5.4. Обработке подлежат только персональные данные, которые отвечают целям их обработки.</p>
        <p>5.5. Содержание и объем обрабатываемых персональных данных соответствуют заявленным целям обработки. Не допускается избыточность обрабатываемых персональных данных по отношению к заявленным целям их обработки.</p>
        <p>5.6. При обработке персональных данных обеспечивается точность персональных данных, их достаточность, а в необходимых случаях и актуальность по отношению к целям обработки персональных данных. Оператор принимает необходимые меры и/или обеспечивает их принятие по удалению или уточнению неполных или неточных данных.</p>
        <p>5.7. Хранение персональных данных осуществляется в форме, позволяющей определить субъекта персональных данных, не дольше, чем этого требуют цели обработки персональных данных, если срок хранения персональных данных не установлен федеральным законом, договором, стороной которого, выгодоприобретателем или поручителем по которому является субъект персональных данных. Обрабатываемые персональные данные уничтожаются либо обезличиваются по достижении целей обработки или в случае утраты необходимости в достижении этих целей, если иное не предусмотрено федеральным законом.</p>

        <h4>6. Цели обработки персональных данных</h4>
        <p><strong>Цель обработки:</strong> Оформление и исполнение заказов в интернет-магазине ювелирных изделий ручной работы KOSHEK: заключение и исполнение договора розничной купли-продажи, комплектование и организация доставки заказа, связь с покупателем по вопросам заказа и информирование о его статусе, оформление возвратов и обращений.</p>
        <p><strong>Персональные данные:</strong></p>
        <ul>
          <li>фамилия, имя, отчество;</li>
          <li>номера телефонов;</li>
          <li>Телеграм ID и username;</li>
          <li>адрес доставки: страна, город, улица/дом/квартира, индекс, ПВЗ СДЭК;</li>
          <li>комментарий к заказу;</li>
          <li>сведения о заказе и оплате: состав, суммы, промокод, способ доставки, трек-номера.</li>
        </ul>
        <p><strong>Правовые основания:</strong> договоры, заключаемые между оператором и субъектом персональных данных.</p>
        <p><strong>Виды обработки персональных данных:</strong> сбор, запись, систематизация, накопление, хранение, уточнение (обновление, изменение), извлечение, использование, передача (предоставление, доступ), блокирование, удаление, уничтожение. Способ — смешанная обработка (с использованием средств автоматизации и без).</p>

        <h4>7. Условия обработки персональных данных</h4>
        <p>7.1. Обработка персональных данных осуществляется с согласия субъекта персональных данных на обработку его персональных данных.</p>
        <p>7.2. Обработка персональных данных необходима для достижения целей, предусмотренных международным договором Российской Федерации или законом, для осуществления возложенных законодательством Российской Федерации на оператора функций, полномочий и обязанностей.</p>
        <p>7.3. Обработка персональных данных необходима для осуществления правосудия, исполнения судебного акта, акта другого органа или должностного лица, подлежащих исполнению в соответствии с законодательством Российской Федерации об исполнительном производстве.</p>
        <p>7.4. Обработка персональных данных необходима для исполнения договора, стороной которого либо выгодоприобретателем или поручителем по которому является субъект персональных данных, а также для заключения договора по инициативе субъекта персональных данных или договора, по которому субъект персональных данных будет являться выгодоприобретателем или поручителем.</p>
        <p>7.5. Обработка персональных данных необходима для осуществления прав и законных интересов оператора или третьих лиц либо для достижения общественно значимых целей при условии, что при этом не нарушаются права и свободы субъекта персональных данных.</p>
        <p>7.6. Осуществляется обработка персональных данных, доступ неограниченного круга лиц к которым предоставлен субъектом персональных данных либо по его просьбе (далее — общедоступные персональные данные).</p>
        <p>7.7. Осуществляется обработка персональных данных, подлежащих опубликованию или обязательному раскрытию в соответствии с федеральным законом.</p>

        <h4>8. Порядок сбора, хранения, передачи и других видов обработки персональных данных</h4>
        <p>Безопасность персональных данных, которые обрабатываются Оператором, обеспечивается путем реализации правовых, организационных и технических мер, необходимых для выполнения в полном объеме требований действующего законодательства в области защиты персональных данных.</p>
        <p>8.1. Оператор обеспечивает сохранность персональных данных и принимает все возможные меры, исключающие доступ к персональным данным неуполномоченных лиц.</p>
        <p>8.2. Персональные данные Пользователя никогда, ни при каких условиях не будут переданы третьим лицам, за исключением случаев, связанных с исполнением действующего законодательства либо в случае, если субъектом персональных данных дано согласие Оператору на передачу данных третьему лицу для исполнения обязательств по гражданско-правовому договору.</p>
        <p>8.3. В случае выявления неточностей в персональных данных, Пользователь может актуализировать их самостоятельно, путем направления Оператору уведомления на адрес электронной почты Оператора olesiasee@mail.ru с пометкой «Актуализация персональных данных».</p>
        <p>8.4. Срок обработки персональных данных определяется достижением целей, для которых были собраны персональные данные, если иной срок не предусмотрен договором или действующим законодательством. Пользователь может в любой момент отозвать свое согласие на обработку персональных данных, направив Оператору уведомление посредством электронной почты на электронный адрес Оператора olesiasee@mail.ru с пометкой «Отзыв согласия на обработку персональных данных».</p>
        <p>8.5. Вся информация, которая собирается сторонними сервисами, в том числе платежными системами, средствами связи и другими поставщиками услуг, хранится и обрабатывается указанными лицами (Операторами) в соответствии с их Пользовательским соглашением и Политикой конфиденциальности. Оператор не несет ответственность за действия третьих лиц, в том числе указанных в настоящем пункте поставщиков услуг.</p>
        <p>8.6. Установленные субъектом персональных данных запреты на передачу (кроме предоставления доступа), а также на обработку или условия обработки (кроме получения доступа) персональных данных, разрешенных для распространения, не действуют в случаях обработки персональных данных в государственных, общественных и иных публичных интересах, определенных законодательством РФ.</p>
        <p>8.7. Оператор при обработке персональных данных обеспечивает конфиденциальность персональных данных.</p>
        <p>8.8. Оператор осуществляет хранение персональных данных в форме, позволяющей определить субъекта персональных данных, не дольше, чем этого требуют цели обработки персональных данных, если срок хранения персональных данных не установлен федеральным законом, договором, стороной которого, выгодоприобретателем или поручителем по которому является субъект персональных данных.</p>
        <p>8.9. Условием прекращения обработки персональных данных может являться достижение целей обработки персональных данных, истечение срока действия согласия субъекта персональных данных, отзыв согласия субъектом персональных данных или требование о прекращении обработки персональных данных, а также выявление неправомерной обработки персональных данных.</p>

        <h4>9. Перечень действий, производимых Оператором с полученными персональными данными</h4>
        <p>9.1. Оператор осуществляет сбор, запись, систематизацию, накопление, хранение, уточнение (обновление, изменение), извлечение, использование, передачу (распространение, предоставление, доступ), обезличивание, блокирование, удаление и уничтожение персональных данных.</p>
        <p>9.2. Оператор осуществляет автоматизированную обработку персональных данных с получением и/или передачей полученной информации по информационно-телекоммуникационным сетям или без таковой.</p>

        <h4>10. Трансграничная передача персональных данных</h4>
        <p>10.1. Оператор до начала осуществления деятельности по трансграничной передаче персональных данных обязан уведомить уполномоченный орган по защите прав субъектов персональных данных о своем намерении осуществлять трансграничную передачу персональных данных (такое уведомление направляется отдельно от уведомления о намерении осуществлять обработку персональных данных).</p>
        <p>10.2. Оператор до подачи вышеуказанного уведомления обязан получить от органов власти иностранного государства, иностранных физических лиц, иностранных юридических лиц, которым планируется трансграничная передача персональных данных, соответствующие сведения.</p>

        <h4>11. Конфиденциальность персональных данных</h4>
        <p>Оператор и иные лица, получившие доступ к персональным данным, обязаны не раскрывать третьим лицам и не распространять персональные данные без согласия субъекта персональных данных, если иное не предусмотрено федеральным законом.</p>

        <h4>12. Заключительные положения</h4>
        <p>12.1. Пользователь может получить любые разъяснения по интересующим вопросам, касающимся обработки его персональных данных, обратившись к Оператору с помощью электронной почты olesiasee@mail.ru.</p>
        <p>12.2. В данном документе будут отражены любые изменения политики обработки персональных данных Оператором. Политика действует бессрочно до замены ее новой версией.</p>
        <p>12.3. Актуальная версия Политики в свободном доступе расположена в сети Интернет по адресу <a href="https://docs.google.com/document/d/16xNZvefjNn_V-1wEYurPFFOw5VP5jkXvbtNa1P4mEAA/edit" target="_blank" rel="noopener noreferrer">https://docs.google.com/document/d/16xNZvefjNn_V-1wEYurPFFOw5VP5jkXvbtNa1P4mEAA/edit</a>.</p>
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

  const [activeIndex, setActiveIndex] = useState(currentIndex)

  return (
    <div className="fullscreen-image" onClick={onClose}>
      <button className="fullscreen-image__close" onClick={handleClose}>&times;</button>

      <Swiper
        modules={[Pagination, Zoom]}
        pagination={{ clickable: true }}
        zoom={true}
        initialSlide={currentIndex}
        onSlideChange={(swiper: SwiperClass) => {
          setActiveIndex(swiper.activeIndex)
          onNavigate(swiper.activeIndex)
        }}
      >
        {images.map((media, idx) => (
          <SwiperSlide key={idx} onClick={(e) => e.stopPropagation()}>
            {isVideo(media) ? (
              <div className="fullscreen-image__video">
                <VideoPlayer src={media} isActive={activeIndex === idx} />
              </div>
            ) : (
              <div className="swiper-zoom-container">
                <img src={media} alt={`Товар (${idx + 1})`} />
              </div>
            )}
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
  const thumbnailsRef = useRef<HTMLDivElement>(null)
  const currentMedia = product.images?.[selectedImageIndex] || ''
  // image-loader только для фото; для видео отдаём '' (Image() не грузит видео)
  const { loading: mainImageLoading } = useImageLoader(isVideo(currentMedia) ? '' : currentMedia)
  const cartItem = cart.find(item => item.kind === 'regular' && item.slug === product.slug)
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

  // лента миниатюр едет за галереей: активную миниатюру держим по центру видимой области,
  // чтобы при листании галереи за границы строки нужная миниатюра всегда была видна
  useEffect(() => {
    const container = thumbnailsRef.current
    if (!container) return
    const active = container.children[selectedImageIndex] as HTMLElement | undefined
    if (!active) return
    const target = active.offsetLeft - (container.clientWidth - active.clientWidth) / 2
    container.scrollTo({ left: Math.max(0, target), behavior: 'smooth' })
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
            {product.coming_drop ? (
              <div className="product-modal__badge">скоро в продаже</div>
            ) : product.badge_text && (
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
                  {isVideo(img) ? (
                    <VideoPlayer
                      src={img}
                      isActive={selectedImageIndex === idx}
                      onFullscreen={() => setFullscreenImage(img)}
                    />
                  ) : (
                    <div
                      className={`product-modal__image ${mainImageLoading && selectedImageIndex === idx ? 'shimmer-bg' : 'fade-in-image'}`}
                      style={
                        mainImageLoading && selectedImageIndex === idx
                          ? {}
                          : { backgroundImage: `url(${img})` }
                      }
                      onClick={() => setFullscreenImage(img)}
                    />
                  )}
                </SwiperSlide>
              ))}
            </Swiper>
            
            {product.images.length > 1 && (
              <div className="product-modal__thumbnails" ref={thumbnailsRef}>
                {product.images.map((img, idx) => (
                  isVideo(img) ? (
                    <VideoThumbnail
                      key={idx}
                      src={img}
                      isActive={selectedImageIndex === idx}
                      onClick={() => setSelectedImageIndex(idx)}
                      aria-label={`Видео ${idx + 1}`}
                    />
                  ) : (
                    <ThumbnailButton
                      key={idx}
                      src={img}
                      isActive={selectedImageIndex === idx}
                      onClick={() => setSelectedImageIndex(idx)}
                      aria-label={`Фото ${idx + 1}`}
                    />
                  )
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
            {product.coming_drop ? (
              <button className="btn btn--coming-drop" disabled>
                в ожидании дропа
              </button>
            ) : product.stock !== undefined && product.stock === 0 ? (
              <button className="btn btn--out-of-stock" disabled>
                Временно нет в наличии
              </button>
            ) : ordersClosed ? (
              <button className="btn btn--out-of-stock" disabled>
                Заказы временно закрыты
              </button>
            ) : (
              <>
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
              </>
            )}
          </div>
        </div>
      </div>
      {fullscreenImage && (
        <FullscreenImage
          images={product.images ?? []}
          currentIndex={Math.max(0, (product.images ?? []).indexOf(fullscreenImage))}
          onClose={() => setFullscreenImage(null)}
          onNavigate={(newIndex) => {
            const url = (product.images ?? [])[newIndex]
            if (url) {
              setFullscreenImage(url)
              setSelectedImageIndex(newIndex)
            }
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
  onCancel,
  appPlatform
}: {
  onConfirm: () => void
  onCancel: () => void
  appPlatform?: string
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
          {appPlatform !== 'max' && (
            <p className="order-success__bot-warning">
              Убедитесь, что у вас начат диалог с ботом, иначе информация о заказе не придёт!
            </p>
          )}
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
  const botUsername = import.meta.env.VITE_BOT_USERNAME || 'koshekjewerlybot'
  // invId — числовой ID без префикса (для deep link к боту)
  const invId = orderId?.replace(/^ORD-/, '') || orderId
  // displayId — с префиксом ORD- для отображения
  const displayId = invId ? `ORD-${invId}` : null

  const handleOpenBot = () => {
    const link = `https://t.me/${botUsername}?start=order_${invId}_success`
    try {
      WebApp.openTelegramLink(link)
    } catch {
      window.open(link, '_blank')
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--success" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <div className="order-success">
          {isSuccess ? (
            <>
              <div className="order-success__icon">✓</div>
              <h2 className="order-success__title">Заказ оформлен!</h2>
              {displayId && (
                <p className="order-success__id">{displayId}</p>
              )}
              <p className="order-success__text">
                Оплата получена. Откройте бот, чтобы получить уведомление о&nbsp;заказе и&nbsp;быть на&nbsp;связи с&nbsp;менеджером.
              </p>
              <div className="order-success__actions">
                <button className="btn order-success__button order-success__button--pink" onClick={handleOpenBot}>
                  Открыть бот 📬
                </button>
                <button className="btn-text order-success__secondary" onClick={onClose}>
                  Продолжить покупки
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="order-success__icon order-success__icon--fail">✕</div>
              <h2 className="order-success__title">Оплата не завершена</h2>
              {displayId && (
                <p className="order-success__id">{displayId}</p>
              )}
              <p className="order-success__text">
                Платёж не прошёл или был отменён. Попробуйте оформить заказ снова.
              </p>
              <button className="btn btn--primary order-success__button" onClick={onClose}>
                Закрыть
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

type CdekCity = { code: number; city: string; region?: string; country_code?: string }
type CdekPvz = { code: string; name: string; address: string; work_time?: string }

// способ доставки: самовывоз / СДЭК ПВЗ / EMS Почта России (международная)
type DeliveryMethod = 'pickup' | 'cdek' | 'ems'

const PICKUP_ADDRESS = 'г. Москва, ул. Горбунова, 2'

// Почта требует латиницу в международном адресе EMS: кириллица → отказ при создании
// отправления (ILLEGAL_STREET_TO_INTL и т.п.). Разрешаем латиницу, цифры и адресную пунктуацию.
const LATIN_TEXT_RE = /^[A-Za-z0-9\s.,'\-/()#&]+$/
const isLatinText = (v: string) => LATIN_TEXT_RE.test(v.trim())

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
  
  // проверяем что все товары в корзине - тестовые. Композиты считаем не-тестовыми.
  const cartItems = cart.map(item => {
    if (item.kind === 'constructor') {
      return { item, product: null, isTest: false }
    }
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
    items: cartItems.map(({ item, isTest }) => ({
      key: item.kind === 'regular' ? item.slug : item.id,
      isTest
    }))
  })
  
  return allTest
}

// компонент формы оформления заказа (СДЭК интеграция)
// Промежуточный экран: выбор региона → (для РФ/СНГ) способа доставки
const DeliveryRegionModal = ({
  onSelect,
  onBack,
  onClose,
}: {
  onSelect: (method: DeliveryMethod) => void
  onBack: () => void
  onClose: () => void
}) => {
  const [step, setStep] = useState<'region' | 'ru-method'>('region')

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--region" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        {step === 'region' ? (
          <>
            <h3 className="delivery-region__title">Куда доставить заказ?</h3>
            <div className="delivery-region__options">
              <button type="button" className="delivery-region__option" onClick={() => setStep('ru-method')}>
                <span className="delivery-region__option-label">Россия и СНГ</span>
                <span className="delivery-region__option-desc">Самовывоз или доставка СДЭК</span>
              </button>
              <button type="button" className="delivery-region__option" onClick={() => onSelect('ems')}>
                <span className="delivery-region__option-label">Международные перевозки</span>
                <span className="delivery-region__option-desc">EMS Почта России</span>
              </button>
            </div>
            <button type="button" className="delivery-region__back" onClick={onBack}>← В корзину</button>
          </>
        ) : (
          <>
            <h3 className="delivery-region__title">Способ получения</h3>
            <div className="delivery-region__options">
              <button type="button" className="delivery-region__option" onClick={() => onSelect('cdek')}>
                <span className="delivery-region__option-label">СДЭК</span>
                <span className="delivery-region__option-desc">Доставка в пункт выдачи</span>
              </button>
              <button type="button" className="delivery-region__option" onClick={() => onSelect('pickup')}>
                <span className="delivery-region__option-label">Самовывоз</span>
                <span className="delivery-region__option-desc">{PICKUP_ADDRESS} · бесплатно</span>
              </button>
            </div>
            <button type="button" className="delivery-region__back" onClick={() => setStep('region')}>← Назад</button>
          </>
        )}
      </div>
    </div>
  )
}

const CheckoutForm = ({
  cartTotal,
  cart,
  products,
  deliveryMethod,
  priorityOrderEnabled = true,
  priorityOrderFee = 30,
  onBack,
  onSubmit
}: {
  cartTotal: number
  cart: CartItem[]
  products: Product[]
  deliveryMethod: DeliveryMethod
  priorityOrderEnabled?: boolean
  priorityOrderFee?: number
  onBack: () => void
  onSubmit: (data: any) => void
}) => {
  const isPickup = deliveryMethod === 'pickup'
  const isEms = deliveryMethod === 'ems'
  const isCdek = deliveryMethod === 'cdek'

  const [formData, setFormData] = useState({
    fullName: '',
    phone: '',
    username: '',
    comments: ''
  })

  // EMS Почта России — международный адрес получателя
  const [emsCountry, setEmsCountry] = useState<Country | null>(null)
  const [emsRegion, setEmsRegion] = useState('')
  const [emsCity, setEmsCity] = useState('')
  const [emsStreet, setEmsStreet] = useState('')
  const [emsIndex, setEmsIndex] = useState('')
  // актуальный список стран с бэкенда (справочник Почты), статический COUNTRIES — фолбэк
  const [countries, setCountries] = useState<Country[]>(COUNTRIES)

  // CDEK
  const [cityQuery, setCityQuery] = useState('')
  const [citySuggestions, setCitySuggestions] = useState<CdekCity[]>([])
  const [showCitySuggestions, setShowCitySuggestions] = useState(false)
  const [selectedCity, setSelectedCity] = useState<CdekCity | null>(null)
  const [cityLoading, setCityLoading] = useState(false)
  const [pvzList, setPvzList] = useState<CdekPvz[]>([])
  const [pvzQuery, setPvzQuery] = useState('')
  const [pvzListOpen, setPvzListOpen] = useState(false)
  const [selectedPvz, setSelectedPvz] = useState<CdekPvz | null>(null)
  const [pvzLoading, setPvzLoading] = useState(false)
  const [deliveryCost, setDeliveryCost] = useState<number | null>(null)
  const [costLoading, setCostLoading] = useState(false)
  const [costError, setCostError] = useState<string | null>(null)
  const cityDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [promocode, setPromocode] = useState('')
  const [promocodeStatus, setPromocodeStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid' | 'not_found'>('idle')
  const [promocodeDiscount, setPromocodeDiscount] = useState(0)
  const [promocodeInfo, setPromocodeInfo] = useState<{ type: 'amount' | 'percent'; value: number } | null>(null)
  const [priorityOrder, setPriorityOrder] = useState(false)
  const [priorityToastOpen, setPriorityToastOpen] = useState(false)
  const priorityAnchorRef = useRef<HTMLDivElement>(null)
  const [priorityToastPos, setPriorityToastPos] = useState<{ top: number; left: number } | null>(null)
  // согласие на обработку персональных данных — обязательно для оформления заказа
  const [consent, setConsent] = useState(false)
  const [policyModalOpen, setPolicyModalOpen] = useState(false)

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

  // подгружаем актуальный справочник стран Почты (только для EMS); при сбое — статический фолбэк
  useEffect(() => {
    if (!isEms) return
    const apiUrl = import.meta.env.VITE_API_URL || ''
    fetch(`${apiUrl}/api/pochta/countries`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: Country[]) => { if (Array.isArray(data) && data.length) setCountries(data) })
      .catch(() => {}) // оставляем статический список
  }, [isEms])

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

  const fetchCities = async (query: string) => {
    if (query.length < 2) { setCitySuggestions([]); setShowCitySuggestions(false); return }
    setCityLoading(true)
    try {
      const apiUrl = import.meta.env.VITE_API_URL || ''
      const resp = await fetch(`${apiUrl}/api/cdek/cities?q=${encodeURIComponent(query)}`)
      if (!resp.ok) throw new Error()
      const data: CdekCity[] = await resp.json()
      setCitySuggestions(data)
      setShowCitySuggestions(data.length > 0)
    } catch {
      setCitySuggestions([])
    } finally {
      setCityLoading(false)
    }
  }

  const handleCityQueryChange = (value: string) => {
    setCityQuery(value)
    if (selectedCity) {
      setSelectedCity(null); setSelectedPvz(null); setPvzList([]); setDeliveryCost(null); setCostError(null)
    }
    if (errors.city) setErrors(prev => ({ ...prev, city: '' }))
    if (cityDebounceRef.current) clearTimeout(cityDebounceRef.current)
    cityDebounceRef.current = setTimeout(() => fetchCities(value), 250)
  }

  const handleCitySelect = async (city: CdekCity) => {
    setSelectedCity(city)
    setCityQuery(`${city.city}${city.region ? ', ' + city.region : ''}`)
    setCitySuggestions([]); setShowCitySuggestions(false)
    setSelectedPvz(null); setPvzQuery(''); setPvzListOpen(false)
    setPvzLoading(true); setPvzList([]); setDeliveryCost(null); setCostError(null)
    if (errors.city) setErrors(prev => ({ ...prev, city: '' }))
    if (errors.pvz) setErrors(prev => ({ ...prev, pvz: '' }))

    const apiUrl = import.meta.env.VITE_API_URL || ''
    try {
      const resp = await fetch(`${apiUrl}/api/cdek/pvz?city_code=${city.code}`)
      const data: CdekPvz[] = await resp.json()
      setPvzList(Array.isArray(data) ? data : [])
    } catch {
      setPvzList([])
    } finally {
      setPvzLoading(false)
    }
  }

  const handlePvzSelect = async (pvz: CdekPvz) => {
    setSelectedPvz(pvz)
    setPvzQuery(pvz.address)
    setPvzListOpen(false)
    if (errors.pvz) setErrors(prev => ({ ...prev, pvz: '' }))
    if (errors.delivery) setErrors(prev => ({ ...prev, delivery: '' }))
    if (isOnlyTestProducts) return
    setCostLoading(true); setCostError(null); setDeliveryCost(null)
    const apiUrl = import.meta.env.VITE_API_URL || ''
    try {
      const resp = await fetch(`${apiUrl}/api/cdek/calculate?city_code=${selectedCity!.code}`)
      if (!resp.ok) throw new Error('cdek_unavailable')
      const data = await resp.json()
      setDeliveryCost(data.delivery_sum)
    } catch {
      setDeliveryCost(null)
      setCostError('Не удалось рассчитать стоимость. Выберите другой город или попробуйте позже.')
    } finally {
      setCostLoading(false)
    }
  }

  // EMS Почта России — расчёт стоимости по стране получателя
  const calcEmsCost = async (country: Country) => {
    if (isOnlyTestProducts) return
    setCostLoading(true); setCostError(null); setDeliveryCost(null)
    const apiUrl = import.meta.env.VITE_API_URL || ''
    try {
      const resp = await fetch(`${apiUrl}/api/pochta/calculate?country=${country.code}`)
      const data = await resp.json().catch(() => ({}))
      if (resp.status === 422 && data?.error === 'delivery_unavailable') {
        // нулевой тариф = доставка Почтой в эту страну недоступна
        setDeliveryCost(null)
        setCostError('Доставка Почтой России в эту страну недоступна. Выберите другую страну.')
        return
      }
      if (!resp.ok || typeof data?.delivery_sum !== 'number') throw new Error('pochta_unavailable')
      setDeliveryCost(data.delivery_sum)
    } catch {
      setDeliveryCost(null)
      setCostError('Не удалось рассчитать стоимость. Выберите другую страну или попробуйте позже.')
    } finally {
      setCostLoading(false)
    }
  }

  const handleCountrySelect = (code: number) => {
    const c = countries.find(x => x.code === code) ?? null
    setEmsCountry(c)
    if (errors.country) setErrors(prev => ({ ...prev, country: '' }))
    if (c) calcEmsCost(c)
  }

  // если в корзине только тестовые товары - доставка бесплатная
  const isOnlyTestProducts = isCartOnlyTestProducts(cart, products)
  const effectiveDeliveryCost = (isOnlyTestProducts || isPickup) ? 0 : (deliveryCost ?? 0)
  const subtotal = cartTotal + effectiveDeliveryCost
  const subtotalAfterDiscount = Math.max(0, subtotal - promocodeDiscount)
  const priorityFee =
    priorityOrderEnabled && priorityOrder && subtotalAfterDiscount > 0
      ? Math.round(subtotalAfterDiscount * priorityOrderFee / 100)
      : 0
  const total = subtotalAfterDiscount + priorityFee

  const filteredPvz = pvzList.filter(p =>
    !pvzQuery ||
    p.address.toLowerCase().includes(pvzQuery.toLowerCase()) ||
    p.name.toLowerCase().includes(pvzQuery.toLowerCase())
  )

  const validate = () => {
    const newErrors: Record<string, string> = {}

    if (!formData.fullName.trim()) newErrors.fullName = 'Обязательное поле'
    else if (formData.fullName.length > 100) newErrors.fullName = 'Максимум 100 символов'

    if (!formData.phone.trim()) newErrors.phone = 'Обязательное поле'
    else if (!/^[\d\s\-\+\(\)]+$/.test(formData.phone)) newErrors.phone = 'Некорректный номер телефона'
    else {
      const digits = formData.phone.replace(/\D/g, '')
      if (digits.length < 10 || digits.length > 12) newErrors.phone = 'Номер должен содержать 10–12 цифр'
    }

    if (isCdek) {
      if (!selectedCity) newErrors.city = 'Выберите город из списка'
      if (!selectedPvz) newErrors.pvz = 'Выберите пункт выдачи СДЭК'
    } else if (isEms) {
      if (!emsCountry) newErrors.country = 'Выберите страну'
      if (!emsIndex.trim()) newErrors.emsIndex = 'Обязательное поле'
      if (!emsCity.trim()) newErrors.emsCity = 'Обязательное поле'
      else if (!isLatinText(emsCity)) newErrors.emsCity = 'Только латинскими буквами'
      if (!emsStreet.trim()) newErrors.emsStreet = 'Обязательное поле'
      else if (!isLatinText(emsStreet)) newErrors.emsStreet = 'Только латинскими буквами'
      if (emsRegion.trim() && !isLatinText(emsRegion)) newErrors.emsRegion = 'Только латинскими буквами'
      // имя получателя уходит в загран-адрес отправления → тоже латиница
      if (formData.fullName.trim() && !isLatinText(formData.fullName)) newErrors.fullName = 'Латиницей, как в загранпаспорте'
    }
    // для СДЭК и EMS стоимость доставки должна быть рассчитана
    if (!isPickup) {
      if (!isOnlyTestProducts && deliveryCost === null && !costError) newErrors.delivery = 'Стоимость доставки не рассчитана'
      if (!isOnlyTestProducts && costError) newErrors.delivery = costError
    }

    if (formData.comments && formData.comments.length > 500) newErrors.comments = 'Максимум 500 символов'

    if (!consent) newErrors.consent = 'Необходимо согласие на обработку персональных данных'

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    let extra: Record<string, any> = {}
    if (isCdek) {
      const country = selectedCity?.country_code === 'RU' ? 'Россия' : (selectedCity?.country_code ?? '')
      extra = {
        city: selectedCity?.city ?? '',
        country,
        address: selectedPvz?.address ?? '',
        pvzCode: selectedPvz?.code ?? '',
        cdekCityCode: selectedCity?.code,
      }
    } else if (isEms) {
      extra = {
        recipientCountry: emsCountry?.name ?? '',
        recipientCountryCode: emsCountry?.code,
        recipientRegion: emsRegion.trim(),
        recipientCity: emsCity.trim(),
        recipientStreet: emsStreet.trim(),
        recipientIndex: emsIndex.trim(),
      }
    } else if (isPickup) {
      extra = { city: 'Москва', country: 'Россия', address: PICKUP_ADDRESS }
    }

    onSubmit({
      ...formData,
      deliveryMethod,
      ...extra,
      deliveryRegion: '',
      deliveryCost: effectiveDeliveryCost,
      total,
      priorityOrder,
      promocode: promocodeStatus === 'valid' ? promocode.trim().toUpperCase() : undefined,
      consent, // согласие на обработку ПДн (всегда true — submit заблокирован без галочки), фиксируем для 152-ФЗ
    })
  }

  const handleChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: '' }))
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
      const currentSubtotal = cartTotal + (deliveryCost ?? 0)
      // получаем slug'и товаров из корзины для проверки привязки промокода (композиты не учитываем — у них синтетические slug'и)
      const orderItemSlugs = cart
        .filter((item): item is RegularCartItem => item.kind === 'regular')
        .map(item => item.slug)
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
    <>
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
            placeholder="Иванов Иван Иванович"
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
            placeholder="+7 (999) 123-45-67"
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

        {isCdek && (<>
        <div className="checkout-form__label" style={{ position: 'relative' }}>
          Город <span className="checkout-form__required">*</span>
          <input
            type="text"
            className={`checkout-form__input ${errors.city ? 'error' : ''}`}
            value={cityQuery}
            onChange={(e) => handleCityQueryChange(e.target.value)}
            onFocus={() => citySuggestions.length > 0 && setShowCitySuggestions(true)}
            onBlur={() => setTimeout(() => setShowCitySuggestions(false), 150)}
            placeholder="Начните вводить город..."
            autoComplete="off"
          />
          {cityLoading && <span style={{ position: 'absolute', right: 12, top: 38, fontSize: 12, color: '#999' }}>...</span>}
          {showCitySuggestions && citySuggestions.length > 0 && (
            <div className="cdek-suggestions">
              {citySuggestions.map(c => (
                <div
                  key={c.code}
                  className="cdek-suggestions__item"
                  onMouseDown={() => handleCitySelect(c)}
                >
                  <span className="cdek-suggestions__city">{c.city}</span>
                  {c.region && <span className="cdek-suggestions__region">, {c.region}</span>}
                </div>
              ))}
            </div>
          )}
          {errors.city && <span className="checkout-form__error">{errors.city}</span>}
        </div>

        {selectedCity && (
          <div className="checkout-form__label" style={{ position: 'relative' }}>
            Пункт выдачи СДЭК <span className="checkout-form__required">*</span>
            {pvzLoading ? (
              <div style={{ padding: '12px 0', color: '#999', fontSize: 14 }}>Загружаем пункты выдачи...</div>
            ) : pvzList.length === 0 ? (
              <div style={{ padding: '12px 0', color: '#d32f2f', fontSize: 14 }}>
                Нет доступных пунктов выдачи для выбранного города
              </div>
            ) : (
              <>
                <input
                  type="text"
                  className={`checkout-form__input ${selectedPvz ? 'cdek-pvz-input--selected' : ''} ${errors.pvz ? 'error' : ''}`}
                  value={pvzQuery}
                  onChange={e => { setPvzQuery(e.target.value); setPvzListOpen(true) }}
                  onFocus={() => {
                    if (selectedPvz) {
                      setSelectedPvz(null); setPvzQuery(''); setDeliveryCost(null); setCostError(null)
                    }
                    setPvzListOpen(true)
                  }}
                  onBlur={() => setTimeout(() => setPvzListOpen(false), 150)}
                  placeholder="Поиск пункта"
                  autoComplete="off"
                />
                {pvzListOpen && (
                  <div className="cdek-suggestions">
                    {filteredPvz.slice(0, 50).map(pvz => (
                      <div key={pvz.code} className="cdek-suggestions__item" onMouseDown={() => handlePvzSelect(pvz)}>
                        <div className="cdek-pvz-item__name">{pvz.name}</div>
                        <div className="cdek-pvz-item__address">{pvz.address}</div>
                        {pvz.work_time && <div className="cdek-pvz-item__hours">{pvz.work_time}</div>}
                      </div>
                    ))}
                    {filteredPvz.length === 0 && (
                      <div style={{ color: '#999', fontSize: 14, padding: '10px 12px' }}>Ничего не найдено</div>
                    )}
                  </div>
                )}
              </>
            )}
            {errors.pvz && <span className="checkout-form__error">{errors.pvz}</span>}
          </div>
        )}
        </>)}

        {isPickup && (
          <div className="checkout-form__pickup-info">
            <div className="checkout-form__pickup-title">Самовывоз</div>
            <div className="checkout-form__pickup-address">{PICKUP_ADDRESS}</div>
            <div className="checkout-form__pickup-note">Заберите заказ по адресу. Доставка — бесплатно.</div>
          </div>
        )}

        {isEms && (<>
          <p className="checkout-form__ems-hint">
            Адрес и имя получателя укажите латинскими буквами.
          </p>
          <label className="checkout-form__label">
            Страна <span className="checkout-form__required">*</span>
            <select
              className={`checkout-form__input ${errors.country ? 'error' : ''}`}
              value={emsCountry?.code ?? ''}
              onChange={e => handleCountrySelect(Number(e.target.value))}
            >
              <option value="" disabled>Выберите страну</option>
              {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
            {errors.country && <span className="checkout-form__error">{errors.country}</span>}
          </label>

          <label className="checkout-form__label">
            Почтовый индекс <span className="checkout-form__required">*</span>
            <input
              type="text"
              className={`checkout-form__input ${errors.emsIndex ? 'error' : ''}`}
              value={emsIndex}
              onChange={e => { setEmsIndex(e.target.value); if (errors.emsIndex) setErrors(prev => ({ ...prev, emsIndex: '' })) }}
              placeholder="Напр. 10115"
              maxLength={20}
            />
            {errors.emsIndex && <span className="checkout-form__error">{errors.emsIndex}</span>}
          </label>

          <label className="checkout-form__label">
            Регион / штат
            <input
              type="text"
              className={`checkout-form__input ${errors.emsRegion ? 'error' : ''}`}
              value={emsRegion}
              onChange={e => { setEmsRegion(e.target.value); if (errors.emsRegion) setErrors(prev => ({ ...prev, emsRegion: '' })) }}
              placeholder="Необязательно"
              maxLength={100}
            />
            {errors.emsRegion && <span className="checkout-form__error">{errors.emsRegion}</span>}
          </label>

          <label className="checkout-form__label">
            Город <span className="checkout-form__required">*</span>
            <input
              type="text"
              className={`checkout-form__input ${errors.emsCity ? 'error' : ''}`}
              value={emsCity}
              onChange={e => { setEmsCity(e.target.value); if (errors.emsCity) setErrors(prev => ({ ...prev, emsCity: '' })) }}
              placeholder="Город"
              maxLength={100}
            />
            {errors.emsCity && <span className="checkout-form__error">{errors.emsCity}</span>}
          </label>

          <label className="checkout-form__label">
            Улица, дом, квартира <span className="checkout-form__required">*</span>
            <input
              type="text"
              className={`checkout-form__input ${errors.emsStreet ? 'error' : ''}`}
              value={emsStreet}
              onChange={e => { setEmsStreet(e.target.value); if (errors.emsStreet) setErrors(prev => ({ ...prev, emsStreet: '' })) }}
              placeholder="Улица, дом, квартира"
              maxLength={200}
            />
            {errors.emsStreet && <span className="checkout-form__error">{errors.emsStreet}</span>}
          </label>
        </>)}

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
            placeholder="Дополнительная информация к заказу"
            rows={3}
            maxLength={500}
          />
          <span className="checkout-form__char-count">{formData.comments.length}/500</span>
          {errors.comments && <span className="checkout-form__error">{errors.comments}</span>}
        </label>

        {priorityOrderEnabled && <div className="checkout-form__priority-wrap" ref={priorityAnchorRef}>
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
                  Стоимость услуги +{priorityOrderFee}% к общей сумме заказа.
                </p>
              </div>
            </>
          )}
        </div>}
      </div>

      <div className="checkout-form__summary">
        <div className="checkout-form__summary-row">
          <span>Товары:</span>
          <span>{cartTotal} ₽</span>
        </div>
        <div className="checkout-form__summary-row">
          <span>{isPickup ? 'Самовывоз:' : isEms ? 'Доставка EMS:' : 'Доставка СДЭК:'}</span>
          <span>
            {(isOnlyTestProducts || isPickup) ? 'Бесплатно' : costLoading ? '...' : costError ? <span style={{ color: '#d32f2f', fontSize: 13 }}>Ошибка расчёта</span> : deliveryCost !== null ? `${deliveryCost} ₽` : '—'}
          </span>
        </div>
        {errors.delivery && (
          <div className="checkout-form__summary-row" style={{ marginTop: -8 }}>
            <span className="checkout-form__error" style={{ fontSize: 13 }}>{errors.delivery}</span>
          </div>
        )}
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
            <span>Приоритетный заказ (+{priorityOrderFee}%):</span>
            <span>{priorityFee} ₽</span>
          </div>
        )}
        <div className="checkout-form__summary-row checkout-form__summary-row--total">
          <span>Итого:</span>
          <strong>{total} ₽</strong>
        </div>
      </div>

      <div className="checkout-form__consent">
        <label className="checkout-form__consent-row">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => {
              setConsent(e.target.checked)
              if (errors.consent) setErrors(prev => ({ ...prev, consent: '' }))
            }}
          />
          <span>
            Я даю согласие на обработку персональных данных и принимаю условия{' '}
            <button
              type="button"
              className="checkout-form__consent-link"
              onClick={() => setPolicyModalOpen(true)}
            >
              Политики обработки персональных данных
            </button>
          </span>
        </label>
        {errors.consent && <span className="checkout-form__error">{errors.consent}</span>}
      </div>

      <button type="submit" className="btn btn--primary checkout-form__submit">
        Оформить заказ
            </button>

    </form>
    {policyModalOpen && <PrivacyPolicyModal onClose={() => setPolicyModalOpen(false)} />}
    </>
  )
}

const CartModal = ({
  cart,
  products,
  onUpdateCart,
  onPreviewComponent,
  onClose,
  onCheckout
}: {
  cart: CartItem[]
  products: Product[]
  onUpdateCart: (key: string, delta: number) => void
  onPreviewComponent: (kind: 'base' | 'pendant', ref: ConstructorComponentRef) => void
  onClose: () => void
  onCheckout: () => void
}) => {
  type ResolvedRegular = { kind: 'regular'; cartItem: RegularCartItem; product: Product; quantity: number; unitPrice: number }
  type ResolvedComposite = { kind: 'constructor'; cartItem: CompositeCartItem; quantity: number; unitPrice: number }
  type Resolved = ResolvedRegular | ResolvedComposite

  const cartItems: Resolved[] = cart
    .map((item): Resolved | null => {
      if (item.kind === 'constructor') {
        return { kind: 'constructor', cartItem: item, quantity: item.quantity, unitPrice: compositeUnitPrice(item) }
      }
      const product = products.find(p => p.slug === item.slug)
      if (!product) return null
      return { kind: 'regular', cartItem: item, product, quantity: item.quantity, unitPrice: getProductPrice(product) }
    })
    .filter((x): x is Resolved => x !== null)

  const total = cartItems.reduce((sum, it) => sum + it.unitPrice * it.quantity, 0)

  const handleCheckout = () => {
    // проверка stock только для обычных товаров (у композитов остатков нет)
    const invalid = cartItems.filter(it => {
      if (it.kind !== 'regular') return false
      const maxQuantity = it.product.stock !== undefined ? it.product.stock : 999
      return it.quantity > maxQuantity
    }) as ResolvedRegular[]

    if (invalid.length > 0) {
      alert(`Недостаточно товара в наличии для:\n${invalid.map(i => i.product.title).join('\n')}`)
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
              {cartItems.map(it => {
                if (it.kind === 'constructor') {
                  const composite = it.cartItem
                  // максимум 3 миниатюры в ряд под основой; если подвесок больше — 2 + «+N»
                  const visible = composite.pendants.length <= 3
                    ? composite.pendants
                    : composite.pendants.slice(0, 2)
                  const overflowCount = composite.pendants.length - visible.length
                  return (
                    <div key={composite.id} className="cart-item">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                        {/* фото основы */}
                        <button
                          type="button"
                          onClick={() => onPreviewComponent('base', composite.base)}
                          aria-label={`Открыть основу: ${composite.base.title}`}
                          className="cart-item__image"
                          style={{
                            backgroundImage: composite.base.image ? `url(${composite.base.image})` : undefined,
                            margin: 0,
                            padding: 0,
                            border: 'none',
                            outline: 'none',
                            appearance: 'none',
                            WebkitAppearance: 'none',
                            cursor: 'pointer'
                          }}
                        />
                        {/* ряд миниатюр подвесок шириной как фото основы */}
                        {composite.pendants.length > 0 && (
                          <div style={{ display: 'flex', gap: 4 }}>
                            {visible.map(p => (
                              <button
                                key={p.id}
                                type="button"
                                onClick={() => onPreviewComponent('pendant', p)}
                                aria-label={`Открыть подвеску: ${p.title}`}
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  aspectRatio: '1 / 1',
                                  padding: 0,
                                  border: 'none',
                                  outline: 'none',
                                  appearance: 'none',
                                  WebkitAppearance: 'none',
                                  borderRadius: 3,
                                  background: p.image
                                    ? `center / cover no-repeat url(${p.image})`
                                    : '#f0f0f0',
                                  cursor: 'pointer'
                                }}
                                title={p.title}
                              />
                            ))}
                            {overflowCount > 0 && (
                              <div style={{
                                flex: 1,
                                minWidth: 0,
                                aspectRatio: '1 / 1',
                                background: '#f4f4f4',
                                border: 'none',
                                borderRadius: 3,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: 11,
                                color: '#888'
                              }}>
                                +{overflowCount}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="cart-item__info">
                        <h3 className="cart-item__title">{TYPE_TITLES[composite.type]} на заказ</h3>
                        <p style={{ fontSize: 12, color: '#666', margin: '4px 0' }}>
                          Основа: {composite.base.title}
                        </p>
                        <p style={{ fontSize: 12, color: '#666', margin: '4px 0' }}>
                          Подвески: {composite.pendants.map(p => p.title).join(', ')}
                        </p>
                        <p className="cart-item__price">{it.unitPrice} ₽ × {it.quantity}</p>
                        <div className="cart-item__controls">
                          <button
                            className="quantity-btn"
                            onClick={() => onUpdateCart(composite.id, -1)}
                            disabled={it.quantity === 0}
                          >
                            −
                          </button>
                          <span className="quantity-value">{it.quantity}</span>
                          <button
                            className="quantity-btn"
                            onClick={() => onUpdateCart(composite.id, 1)}
                          >
                            +
                          </button>
                          <button
                            className="cart-item__remove"
                            onClick={() => onUpdateCart(composite.id, -999)}
                            aria-label="Удалить композит"
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                }

                const product = it.product
                const maxQuantity = product.stock !== undefined ? product.stock : 999
                const canAddMore = it.quantity < maxQuantity
                return (
                  <div key={product.slug} className="cart-item">
                    {product.images && product.images.length > 0 && (
                      <div
                        className="cart-item__image"
                        style={{ backgroundImage: `url(${firstPhoto(product.images)})` }}
                      />
                    )}
                    <div className="cart-item__info">
                      <h3 className="cart-item__title">{product.title}</h3>
                      <p className="cart-item__price">{it.unitPrice} ₽ × {it.quantity}</p>
                      <div className="cart-item__controls">
                        <button
                          className="quantity-btn"
                          onClick={() => onUpdateCart(product.slug, -1)}
                          disabled={it.quantity === 0}
                        >
                          −
                        </button>
                        <span className="quantity-value">{it.quantity}</span>
                        <button
                          className="quantity-btn"
                          onClick={() => onUpdateCart(product.slug, 1)}
                          disabled={!canAddMore}
                        >
                          +
                        </button>
                        <button
                          className="cart-item__remove"
                          onClick={() => onUpdateCart(product.slug, -999)}
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
    img.onload = () => setLoaded(true)
    img.onerror = () => {
      setError(true)
      setLoaded(true) // показываем даже при ошибке
    }
    img.src = src

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
    img.onload = () => setLoading(false)
    img.onerror = () => {
      setError(true)
      setLoading(false)
    }
    img.src = src

    return () => {
      img.onload = null
      img.onerror = null
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
  const [deliveryRegionOpen, setDeliveryRegionOpen] = useState(false)
  const [deliveryMethod, setDeliveryMethod] = useState<DeliveryMethod | null>(null)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>(defaultCategories)
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [cart, setCart] = useState<CartItem[]>([])
  // preview-карточка компонента из корзины (только просмотр, без действий)
  const [cartPreview, setCartPreview] = useState<ConstructorDetailView>(null)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [orderSuccessOpen, setOrderSuccessOpen] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(null)
  const [paymentStatus, setPaymentStatus] = useState<'success' | 'fail' | null>(null)
  const [paymentRedirectOpen, setPaymentRedirectOpen] = useState(false)
  const [pendingPaymentUrl, setPendingPaymentUrl] = useState<string | null>(null)
  const [telegramRequiredOpen, setTelegramRequiredOpen] = useState(false)
  const [ordersClosed, setOrdersClosed] = useState(false)
  const [ordersClosedBanner, setOrdersClosedBanner] = useState(false)
  const [ordersCloseDate, setOrdersCloseDate] = useState<string | undefined>(undefined)
  const [ordersClosedModalOpen, setOrdersClosedModalOpen] = useState(false)
  const [bannerEnabled, setBannerEnabled] = useState(false)
  const [bannerText, setBannerText] = useState('')
  const [bannerStyle, setBannerStyle] = useState<'pink' | 'gold' | 'neutral'>('neutral')
  const [bannerDateFrom, setBannerDateFrom] = useState<string | undefined>(undefined)
  const [bannerDateTo, setBannerDateTo] = useState<string | undefined>(undefined)
  const [priorityOrderEnabled, setPriorityOrderEnabled] = useState(true)
  const [priorityOrderFee, setPriorityOrderFee] = useState(30)
  const mainContentRef = useRef<HTMLElement>(null)
  const productsTitleRef = useRef<HTMLHeadingElement>(null)
  
  // предзагрузка фонового изображения
  const { loaded: headerImageLoaded } = useImagePreload(backgroundImage)
  const { loaded: logoImageLoaded } = useImagePreload(logoImage)
  
  // обработка возврата после оплаты
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const payment = urlParams.get('payment')
    // orderId — наш параметр (MAX/fallback), InvId — от Робокассы напрямую
    const orderIdFromUrl = urlParams.get('orderId') || urlParams.get('InvId')

    if ((payment === 'success' || payment === 'fail') && orderIdFromUrl) {
      setOrderId(orderIdFromUrl)
      setPaymentStatus(payment)
      setOrderSuccessOpen(true)
      // убираем payment-параметры из URL чтобы не показывать при обновлении
      const clean = new URL(window.location.href)
      clean.searchParams.delete('payment')
      clean.searchParams.delete('orderId')
      clean.searchParams.delete('InvId')
      window.history.replaceState({}, '', clean.toString())
    }
  }, [])

  // загрузка категорий из API
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || '/api'
        const url = apiUrl.endsWith('/api') ? `${apiUrl}/categories` : `${apiUrl}/api/categories`
        const response = await fetchWithRetry(url)
        if (response.ok) {
          const data = await response.json()
          const list = data.categories || []
          if (list.length > 0) {
            setCategories(list.map((c: { key: string; title: string; description?: string; image: string; image_position?: string }) => ({
              key: c.key,
              title: c.title,
              description: c.description,
              image: rewriteImageUrl(c.image),
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

  // загрузка статуса заказов и баннера
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || '/api'
        const baseUrl = apiUrl.endsWith('/api') ? `${apiUrl}/settings/orders-status` : `${apiUrl}/api/settings/orders-status`
        const chatId = WebApp.initDataUnsafe?.user?.id
        const url = chatId ? `${baseUrl}?chatId=${chatId}` : baseUrl
        const response = await fetchWithRetry(url)
        if (response.ok) {
          const data = await response.json()
          setOrdersClosed(data.ordersClosed || false)
          setOrdersClosedBanner(data.ordersClosedBanner ?? data.ordersClosed ?? false)
          setOrdersCloseDate(data.closeDate)

          if (data.banner) {
            setBannerEnabled(data.banner.bannerEnabled || false)
            setBannerText(data.banner.bannerText || '')
            setBannerStyle(data.banner.bannerStyle || 'neutral')
            setBannerDateFrom(data.banner.bannerDateFrom)
            setBannerDateTo(data.banner.bannerDateTo)
          }
          // отсутствие ключа = включено (обратная совместимость)
          setPriorityOrderEnabled(data.priorityOrderEnabled !== false)
          if (typeof data.priorityOrderFee === 'number') setPriorityOrderFee(data.priorityOrderFee)
        }
      } catch (error) {
        console.error('[mini-app] ошибка загрузки настроек:', error)
      }
    }
    loadSettings()
  }, [])

  // управление корзиной с проверкой stock и статуса заказов.
  // key — slug для regular items или canonical id для композитов.
  const updateCart = (key: string, delta: number) => {
    console.log('[mini-app] updateCart вызван:', { key, delta, ordersClosed })
    if (delta > 0 && ordersClosed) {
      console.log('[mini-app] заказы закрыты, показываем модальное окно')
      setOrdersClosedModalOpen(true)
      return
    }

    setCart(prev => {
      const matches = (item: CartItem) =>
        item.kind === 'regular' ? item.slug === key : item.id === key

      const existing = prev.find(matches)

      // нет такого item в корзине → если delta>0, добавляем как обычный товар (композиты добавляются через addComposite)
      if (!existing) {
        if (delta < 0) return prev
        const product = products.find(p => p.slug === key)
        if (!product) return prev
        const maxQuantity = product.stock !== undefined ? product.stock : 999
        const qty = Math.min(maxQuantity, Math.max(1, delta))
        return [...prev, { kind: 'regular', slug: key, quantity: qty }]
      }

      // лимит для regular из stock; для композита — без ограничения
      let maxQuantity = 999
      if (existing.kind === 'regular') {
        const product = products.find(p => p.slug === existing.slug)
        if (!product) return prev
        maxQuantity = product.stock !== undefined ? product.stock : 999
      }

      if (delta < 0) {
        if (existing.quantity === 0) return prev
        const newQuantity = Math.max(0, existing.quantity + delta)
        if (newQuantity === 0) {
          return prev.filter(item => !matches(item))
        }
        return prev.map(item => matches(item) ? { ...item, quantity: newQuantity } : item)
      } else {
        const newQuantity = Math.min(maxQuantity, existing.quantity + delta)
        return prev.map(item => matches(item) ? { ...item, quantity: newQuantity } : item)
      }
    })
  }

  // добавление композита из конструктора в корзину (или инкремент quantity, если такой уже есть)
  const addComposite = (composite: ConstructorComposite) => {
    if (ordersClosed) {
      setOrdersClosedModalOpen(true)
      return
    }
    setCart(prev => {
      const id = makeCompositeId(composite)
      const existing = prev.find((item): item is CompositeCartItem => item.kind === 'constructor' && item.id === id)
      if (existing) {
        return prev.map(item =>
          item.kind === 'constructor' && item.id === id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        )
      }
      const newItem: CompositeCartItem = {
        kind: 'constructor',
        id,
        type: composite.type,
        base: {
          id: composite.base.id,
          title: composite.base.title,
          description: composite.base.description,
          image: composite.base.images[0] || '',
          images: composite.base.images,
          price: composite.base.price
        },
        pendants: composite.pendants.map(p => ({
          id: p.id,
          title: p.title,
          description: p.description,
          image: p.images[0] || '',
          images: p.images,
          price: p.price
        })),
        quantity: 1
      }
      return [...prev, newItem]
    })
  }

  const cartTotal = cart.reduce((sum, item) => sum + item.quantity, 0)

  // расчет суммы корзины
  const cartTotalPrice = cart.reduce((sum, item) => {
    if (item.kind === 'constructor') {
      return sum + compositeUnitPrice(item) * item.quantity
    }
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
    fetchWithRetry(`${apiUrl}/api/products`)
      .then(res => res.json())
      .then(data => {
        setProducts((data.items || []).map((p: Product) => ({
          ...p,
          images: (p.images || []).map(rewriteImageUrl),
        })))
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
        setCheckoutOpen(false)
        setDeliveryRegionOpen(true)
      } else if (deliveryRegionOpen) {
        setDeliveryRegionOpen(false)
        setCartOpen(true)
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

    if (selectedProduct || cartOpen || aboutModalOpen || selectedCategory || checkoutOpen || deliveryRegionOpen || paymentRedirectOpen || telegramRequiredOpen) {
      WebApp.BackButton.show()
      WebApp.BackButton.onClick(handleBackButtonClick)
    } else {
      WebApp.BackButton.hide()
    }

    if (selectedProduct || cartOpen || aboutModalOpen || checkoutOpen || deliveryRegionOpen || paymentRedirectOpen || telegramRequiredOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = 'unset'
    }

    return () => {
      WebApp.BackButton.offClick(handleBackButtonClick)
      document.body.style.overflow = 'unset'
    }
  }, [selectedProduct, cartOpen, aboutModalOpen, selectedCategory, checkoutOpen, deliveryRegionOpen, paymentRedirectOpen, telegramRequiredOpen])

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

    // открываем промежуточный экран выбора региона/способа доставки
    setCartOpen(false)
    setDeliveryRegionOpen(true)
  }

  // выбор способа доставки на промежуточном экране → переход к оформлению
  const handleDeliveryMethodSelect = (method: DeliveryMethod) => {
    setDeliveryMethod(method)
    setDeliveryRegionOpen(false)
    setCheckoutOpen(true)
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

  const handleCheckoutSubmit = async (data: any) => {
    try {
      // собираем данные заказа с товарами из корзины (regular + composite)
      const orderItems = cart.map(item => {
        if (item.kind === 'constructor') {
          return {
            kind: 'constructor' as const,
            type: item.type,
            baseId: item.base.id,
            pendantIds: item.pendants.map(p => p.id),
            quantity: item.quantity,
            // подсказка для бэкенда (он всё равно пересчитывает на свежих ценах)
            title: compositeTitle(item),
            price: compositeUnitPrice(item)
          }
        }
        const product = products.find(p => p.slug === item.slug)
        return product ? {
          kind: 'regular' as const,
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

  // баннер показываем если включён и текущая дата входит в диапазон (если задан)
  const isBannerVisible = (() => {
    if (!bannerEnabled || !bannerText.trim()) return false
    const today = new Date().toISOString().split('T')[0]
    if (bannerDateFrom && today < bannerDateFrom) return false
    if (bannerDateTo && today > bannerDateTo) return false
    return true
  })()

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
        {isBannerVisible && (
          <div className={`app-banner app-banner--${bannerStyle}`}>
            {bannerText}
          </div>
        )}
        {ordersClosedBanner && (
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
          ) : selectedCategory === CONSTRUCTOR_CATEGORY_KEY ? (
            <Constructor
              key="constructor"
              apiUrl={import.meta.env.VITE_API_URL || ''}
              onAddToCart={(composite) => {
                addComposite(composite)
                setToastMessage('Украшение добавлено в корзину')
                setSelectedCategory(null)
              }}
              onClose={() => setSelectedCategory(null)}
            />
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
                  {filteredProducts.map(product => {
                    const outOfStock = product.stock !== undefined && product.stock === 0
                    const comingDrop = product.coming_drop === true
                    return (
                    <motion.div
                      key={product.slug}
                      className={`product-card${outOfStock ? ' product-card--out-of-stock' : ''}${comingDrop ? ' product-card--coming-drop' : ''}`}
                      onClick={() => setSelectedProduct(product)}
                      variants={itemVariants}
                    >
                      <div className="product-card__image-wrapper">
                        <ImageWithLoader
                          src={product.images && product.images.length > 0 ? firstPhoto(product.images) : ''}
                          alt={product.title}
                        />
                        {comingDrop ? (
                          <div className="product-card__badge">скоро в продаже</div>
                        ) : (
                          <>
                            {product.badge_text && !outOfStock && (
                              <div className="product-card__badge">
                                {product.badge_text}
                              </div>
                            )}
                            {outOfStock && (
                              <div className="product-card__oos-badge">
                                временно нет в наличии
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      <div className="product-card__info">
                        <h3 className="product-card__title">{product.title}</h3>
                        {comingDrop ? (
                          <p className="product-card__coming-drop-label">в ожидании дропа</p>
                        ) : (
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
                        )}
                      </div>
                    </motion.div>
                  )})}
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
          onPreviewComponent={(kind, ref) => {
            const data = {
              id: ref.id,
              title: ref.title,
              description: ref.description,
              images: ref.images && ref.images.length > 0 ? ref.images : (ref.image ? [ref.image] : []),
              price: ref.price,
              ...(kind === 'base' ? { limit: 0 } : {})
            } as any
            setCartPreview({ kind, data })
          }}
          onClose={() => setCartOpen(false)}
          onCheckout={handleCheckoutStart}
        />
      )}

      {cartPreview && (
        <ConstructorDetailModal
          detail={cartPreview}
          mode="cart-preview"
          onClose={() => setCartPreview(null)}
        />
      )}
      
      {deliveryRegionOpen && (
        <DeliveryRegionModal
          onSelect={handleDeliveryMethodSelect}
          onBack={() => { setDeliveryRegionOpen(false); setCartOpen(true) }}
          onClose={() => setDeliveryRegionOpen(false)}
        />
      )}

      {checkoutOpen && deliveryMethod && (
        <div className="modal-overlay" onClick={() => setCheckoutOpen(false)}>
          <div className="modal-content modal-content--checkout" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setCheckoutOpen(false)}>&times;</button>
            {isBannerVisible && (
              <div className={`app-banner app-banner--inline app-banner--${bannerStyle}`}>
                {bannerText}
              </div>
            )}
            <CheckoutForm
              cartTotal={cartTotalPrice}
              cart={cart}
              products={products}
              deliveryMethod={deliveryMethod}
              priorityOrderEnabled={priorityOrderEnabled}
              priorityOrderFee={priorityOrderFee}
              onBack={() => { setCheckoutOpen(false); setDeliveryRegionOpen(true) }}
              onSubmit={handleCheckoutSubmit}
            />
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
              appPlatform={appPlatform}
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


