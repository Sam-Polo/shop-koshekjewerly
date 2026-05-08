import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Swiper, SwiperSlide } from 'swiper/react'
import { Pagination, Navigation } from 'swiper/modules'

export type JewelryType = 'necklace' | 'earrings' | 'bracelet'

export type ConstructorBase = {
  id: string
  title: string
  description?: string
  images: string[]
  price: number
  /** 0 = без ограничения, N>0 = максимум подвесок */
  limit: number
}

export type ConstructorPendant = {
  id: string
  title: string
  description?: string
  images: string[]
  price: number
}

export type ConstructorComposite = {
  type: JewelryType
  base: ConstructorBase
  pendants: ConstructorPendant[]
}

const TYPES: { key: JewelryType; title: string }[] = [
  { key: 'necklace', title: 'Колье' },
  { key: 'earrings', title: 'Серьги' },
  { key: 'bracelet', title: 'Браслет' }
]

const BADGE_COLOR = '#5e6623'

type Step = 'type' | 'base' | 'pendants'
type DetailView =
  | { kind: 'base'; data: ConstructorBase }
  | { kind: 'pendant'; data: ConstructorPendant }
  | null

function ImageBg({ url, className, style }: { url: string | undefined, className?: string, style?: React.CSSProperties }) {
  return (
    <div
      className={className}
      style={{
        backgroundImage: url ? `url(${url})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundColor: '#f0f0f0',
        ...style
      }}
    />
  )
}

// фоновое фото с состояниями загрузки (shimmer → fade-in), как в основном каталоге
function ImageWithLoader({ src, className }: { src: string | undefined, className?: string }) {
  const [loaded, setLoaded] = useState(false)
  const [errored, setErrored] = useState(false)
  useEffect(() => {
    setLoaded(false)
    setErrored(false)
    if (!src) {
      setErrored(true)
      return
    }
    const img = new Image()
    img.onload = () => setLoaded(true)
    img.onerror = () => setErrored(true)
    img.src = src
  }, [src])

  if (errored || !src) {
    return <div className={`${className ?? ''} product-card__image--placeholder`} />
  }
  return (
    <div
      className={`${className ?? ''} ${loaded ? 'fade-in-image' : 'shimmer-bg'}`}
      style={loaded ? { backgroundImage: `url(${src})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}
    />
  )
}

function SkeletonGrid({ count }: { count: number }) {
  return (
    <div className="products-grid" style={{ padding: '0 16px' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="product-card">
          <div className="product-card__image-wrapper">
            <div className="product-card__image shimmer-bg" />
          </div>
          <div className="product-card__info">
            <div className="shimmer-bg" style={{ height: 16, width: '70%', marginBottom: 8, borderRadius: 2 }} />
            <div className="shimmer-bg" style={{ height: 14, width: '40%', borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// fetch с retry+backoff — Render free tier просыпается ~30с, бывают сетевые сбои
async function fetchJsonWithRetry<T>(url: string, attempts = 4): Promise<T> {
  let lastErr: any = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json() as T
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        // 600мс, 1.2с, 2.4с
        await new Promise(r => setTimeout(r, 600 * Math.pow(2, i)))
      }
    }
  }
  throw lastErr
}

export default function Constructor({
  apiUrl,
  onAddToCart,
  onClose
}: {
  apiUrl: string
  onAddToCart: (composite: ConstructorComposite) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>('type')
  const [selectedType, setSelectedType] = useState<JewelryType | null>(null)
  const [bases, setBases] = useState<ConstructorBase[]>([])
  const [selectedBase, setSelectedBase] = useState<ConstructorBase | null>(null)
  const [pendants, setPendants] = useState<ConstructorPendant[]>([])
  const [selectedPendantIds, setSelectedPendantIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailView>(null)

  useEffect(() => {
    if (!selectedType) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchJsonWithRetry<{ bases?: ConstructorBase[] }>(`${apiUrl}/api/constructor/bases?type=${selectedType}`)
      .then(data => { if (!cancelled) setBases(data.bases || []) })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить основы. Попробуйте обновить страницу.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedType, apiUrl])

  useEffect(() => {
    if (step !== 'pendants' || !selectedType) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchJsonWithRetry<{ pendants?: ConstructorPendant[] }>(`${apiUrl}/api/constructor/pendants?type=${selectedType}`)
      .then(data => { if (!cancelled) setPendants(data.pendants || []) })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить подвески. Попробуйте обновить страницу.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [step, selectedType, apiUrl])

  const goBack = () => {
    setError(null)
    setDetail(null)
    if (step === 'pendants') {
      setStep('base')
      setSelectedPendantIds([])
    } else if (step === 'base') {
      setStep('type')
      setSelectedBase(null)
      setBases([])
    } else {
      onClose()
    }
  }

  const handlePickType = (t: JewelryType) => {
    setSelectedType(t)
    setSelectedBase(null)
    setSelectedPendantIds([])
    setStep('base')
  }

  const handleConfirmBase = (b: ConstructorBase) => {
    setSelectedBase(b)
    setSelectedPendantIds([])
    setStep('pendants')
    setDetail(null)
  }

  const limit = selectedBase?.limit ?? 1
  const reachedLimit = limit > 0 && selectedPendantIds.length >= limit

  const togglePendant = (id: string) => {
    setSelectedPendantIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      if (limit > 0 && prev.length >= limit) return prev
      return [...prev, id]
    })
  }

  const totalPrice = (() => {
    if (!selectedBase) return 0
    const pendantsPrice = pendants
      .filter(p => selectedPendantIds.includes(p.id))
      .reduce((sum, p) => sum + p.price, 0)
    return selectedBase.price + pendantsPrice
  })()

  const canAddToCart =
    !!selectedType &&
    !!selectedBase &&
    selectedPendantIds.length >= 1

  const handleAdd = () => {
    if (!canAddToCart || !selectedBase || !selectedType) return
    const chosenPendants = pendants.filter(p => selectedPendantIds.includes(p.id))
    onAddToCart({
      type: selectedType,
      base: selectedBase,
      pendants: chosenPendants
    })
  }

  return (
    <motion.section
      key="constructor"
      className="constructor-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      style={{
        fontFamily: 'inherit',
        paddingBottom: selectedBase ? 160 : 24
      }}
    >
      {/* шапка с кнопкой "назад" и заголовком шага */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px 0' }}>
        <button
          type="button"
          onClick={goBack}
          aria-label="Назад"
          style={{
            background: 'transparent',
            border: 'none',
            padding: 8,
            cursor: 'pointer',
            fontSize: 22,
            lineHeight: 1,
            fontFamily: 'inherit',
            color: 'inherit'
          }}
        >
          ←
        </button>
      </div>

      <h2
        style={{
          fontFamily: "'Forum', serif",
          fontSize: 24,
          fontWeight: 400,
          letterSpacing: '0.04em',
          textAlign: 'center',
          margin: '8px 16px 16px',
          lineHeight: 1.3
        }}
      >
        {step === 'type' && 'Выбери тип украшения'}
        {step === 'base' && 'Шаг 1: Выбери базу для украшения'}
        {step === 'pendants' && 'Шаг 2: Добавь подвеску, одну или несколько'}
      </h2>

      {step === 'pendants' && limit > 0 && (
        <p style={{
          textAlign: 'center',
          margin: '0 16px 16px',
          fontSize: 14,
          color: '#666',
          fontFamily: 'inherit'
        }}>
          Можно выбрать до {limit}{' '}
          {limit === 1 ? 'подвески' : limit < 5 ? 'подвесок' : 'подвесок'}
        </p>
      )}

      {error && (
        <p style={{ padding: 16, color: '#c33', textAlign: 'center' }}>{error}</p>
      )}

      <AnimatePresence mode="wait">
        {step === 'type' && (
          <motion.div
            key="type"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{
              display: 'grid',
              gap: 12,
              padding: 16
            }}
          >
            {TYPES.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => handlePickType(t.key)}
                style={{
                  padding: '20px 24px',
                  background: '#fff',
                  color: BADGE_COLOR,
                  border: `1px solid ${BADGE_COLOR}`,
                  borderRadius: 999,
                  cursor: 'pointer',
                  fontFamily: "'Forum', serif",
                  fontSize: 18,
                  fontWeight: 400,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  textAlign: 'center',
                  transition: 'background-color 0.2s ease, color 0.2s ease',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
                }}
              >
                {t.title}
              </button>
            ))}
          </motion.div>
        )}

        {step === 'base' && (
          <motion.div
            key="base"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {loading ? (
              <SkeletonGrid count={6} />
            ) : bases.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: '#888' }}>
                Пока нет доступных основ для этого типа
              </p>
            ) : (
              <div className="products-grid" style={{ padding: '0 16px' }}>
                {bases.map(b => (
                  <div
                    key={b.id}
                    className="product-card"
                    onClick={() => setDetail({ kind: 'base', data: b })}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="product-card__image-wrapper">
                      <ImageWithLoader src={b.images[0]} className="product-card__image" />
                    </div>
                    <div className="product-card__info">
                      <h3 className="product-card__title">{b.title}</h3>
                      <p className="product-card__price">
                        <span>{b.price} ₽</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {step === 'pendants' && (
          <motion.div
            key="pendants"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {loading ? (
              <SkeletonGrid count={6} />
            ) : pendants.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: '#888' }}>
                Пока нет подвесок для этого типа
              </p>
            ) : (
              <div className="products-grid" style={{ padding: '0 16px' }}>
                {pendants.map(p => {
                  const selected = selectedPendantIds.includes(p.id)
                  const disabled = !selected && reachedLimit
                  return (
                    <div
                      key={p.id}
                      className="product-card"
                      onClick={() => !disabled && setDetail({ kind: 'pendant', data: p })}
                      style={{
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        opacity: disabled ? 0.4 : 1,
                        outline: selected ? `2px solid ${BADGE_COLOR}` : 'none',
                        outlineOffset: -2,
                        position: 'relative',
                        transition: 'opacity 0.2s, outline-color 0.2s'
                      }}
                    >
                      {selected && (
                        <div className="product-card__badge" style={{ background: BADGE_COLOR }}>
                          выбрано
                        </div>
                      )}
                      <div className="product-card__image-wrapper">
                        <ImageWithLoader src={p.images[0]} className="product-card__image" />
                      </div>
                      <div className="product-card__info">
                        <h3 className="product-card__title">{p.title}</h3>
                        <p className="product-card__price">
                          <span>{p.price} ₽</span>
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* sticky-превью внизу когда уже выбрана основа */}
      {selectedBase && (step === 'base' || step === 'pendants') && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            background: '#fff',
            borderTop: '1px solid #e8e8e8',
            padding: '12px 16px',
            boxShadow: '0 -4px 12px rgba(0,0,0,0.06)',
            zIndex: 100,
            fontFamily: 'inherit'
          }}
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', overflowX: 'auto', marginBottom: 10, paddingTop: 6 }}>
            {/* основа — кликабельна, открывает её карточку. без × (основу нельзя убрать без переключения шага) */}
            <button
              type="button"
              onClick={() => selectedBase && setDetail({ kind: 'base', data: selectedBase })}
              aria-label={`Открыть карточку: ${selectedBase.title}`}
              style={{
                flexShrink: 0,
                width: 52,
                height: 52,
                padding: 0,
                background: 'transparent',
                border: `2px solid rgba(94, 102, 35, 0.45)`,
                borderRadius: 6,
                cursor: 'pointer',
                overflow: 'hidden'
              }}
            >
              <ImageBg url={selectedBase.images[0]} style={{ width: '100%', height: '100%' }} />
            </button>

            {/* подвески — клик открывает карточку, × удаляет (зона нажатия больше иконки) */}
            {selectedPendantIds.map(id => {
              const p = pendants.find(x => x.id === id)
              if (!p) return null
              return (
                <div key={id} style={{ position: 'relative', flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setDetail({ kind: 'pendant', data: p })}
                    aria-label={`Открыть карточку: ${p.title}`}
                    style={{
                      width: 52,
                      height: 52,
                      padding: 0,
                      background: 'transparent',
                      border: `1px solid rgba(94, 102, 35, 0.25)`,
                      borderRadius: 6,
                      cursor: 'pointer',
                      overflow: 'hidden',
                      display: 'block'
                    }}
                  >
                    <ImageBg url={p.images[0]} style={{ width: '100%', height: '100%' }} />
                  </button>
                  {/* зона удаления — 26x26 для пальца, иконка × визуально 14px */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      togglePendant(id)
                    }}
                    aria-label={`Убрать подвеску: ${p.title}`}
                    style={{
                      position: 'absolute',
                      top: -10,
                      right: -10,
                      width: 26,
                      height: 26,
                      padding: 0,
                      borderRadius: '50%',
                      background: '#fff',
                      border: '1px solid rgba(0,0,0,0.15)',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#666',
                      fontSize: 14,
                      lineHeight: 1
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            <div style={{
              marginLeft: 'auto',
              fontSize: 18,
              fontWeight: 600,
              fontFamily: "'Forum', serif",
              paddingLeft: 8,
              whiteSpace: 'nowrap',
              color: '#bf9243'
            }}>
              {totalPrice} ₽
            </div>
          </div>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!canAddToCart}
            style={{
              width: '100%',
              padding: 14,
              fontSize: 15,
              fontWeight: 400,
              fontFamily: "'Forum', serif",
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: canAddToCart ? BADGE_COLOR : '#ccc',
              color: '#fff',
              border: 'none',
              borderRadius: 0,
              cursor: canAddToCart ? 'pointer' : 'not-allowed'
            }}
          >
            {selectedPendantIds.length === 0
              ? 'Выберите подвеску'
              : 'В корзину'}
          </button>
        </div>
      )}

      {/* детальная карточка компонента */}
      {detail && (
        <DetailModal
          detail={detail}
          alreadySelected={detail.kind === 'pendant' && selectedPendantIds.includes(detail.data.id)}
          canSelectMore={!reachedLimit}
          onClose={() => setDetail(null)}
          onConfirmBase={handleConfirmBase}
          onTogglePendant={togglePendant}
        />
      )}
    </motion.section>
  )
}

function DetailModal({
  detail,
  alreadySelected,
  canSelectMore,
  onClose,
  onConfirmBase,
  onTogglePendant
}: {
  detail: NonNullable<DetailView>
  alreadySelected: boolean
  canSelectMore: boolean
  onClose: () => void
  onConfirmBase: (b: ConstructorBase) => void
  onTogglePendant: (id: string) => void
}) {
  const data = detail.data
  const images = data.images.length > 0 ? data.images : ['']

  const handleAction = () => {
    if (detail.kind === 'base') {
      onConfirmBase(detail.data)
    } else {
      onTogglePendant(detail.data.id)
      onClose()
    }
  }

  let actionLabel = ''
  let actionEnabled = true
  if (detail.kind === 'base') {
    actionLabel = 'Выбрать эту основу'
  } else if (alreadySelected) {
    actionLabel = 'Убрать из подборки'
  } else if (!canSelectMore) {
    actionLabel = 'Лимит подвесок достигнут'
    actionEnabled = false
  } else {
    actionLabel = 'Добавить подвеску'
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content modal-content--product"
        onClick={e => e.stopPropagation()}
        style={{ fontFamily: 'inherit' }}
      >
        <button className="modal-close" onClick={onClose}>&times;</button>

        <div className="product-modal__gallery">
          {images.length > 1 ? (
            <Swiper
              modules={[Pagination, Navigation]}
              pagination={{ clickable: true }}
              navigation
              spaceBetween={0}
              slidesPerView={1}
            >
              {images.map((img, i) => (
                <SwiperSlide key={i}>
                  <div className="product-modal__image-wrapper">
                    <ImageBg url={img} className="product-modal__image" />
                  </div>
                </SwiperSlide>
              ))}
            </Swiper>
          ) : (
            <div className="product-modal__image-wrapper">
              <ImageBg url={images[0]} className="product-modal__image" />
            </div>
          )}
        </div>

        <div style={{ padding: '20px 20px 24px' }}>
          <h2 style={{
            margin: '0 0 8px',
            fontSize: 24,
            fontFamily: "'Forum', serif",
            fontWeight: 400
          }}>
            {data.title}
          </h2>
          <p style={{
            margin: '0 0 16px',
            fontSize: 18,
            fontWeight: 600,
            color: '#bf9243',
            fontFamily: "'Forum', serif"
          }}>
            {data.price} ₽
          </p>
          {data.description && (
            <p style={{
              margin: '0 0 20px',
              fontSize: 14,
              lineHeight: 1.5,
              color: '#555',
              fontFamily: 'inherit',
              whiteSpace: 'pre-wrap'
            }}>
              {data.description}
            </p>
          )}
          <button
            type="button"
            onClick={handleAction}
            disabled={!actionEnabled}
            style={{
              width: '100%',
              padding: 14,
              fontSize: 14,
              fontFamily: "'Forum', serif",
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: actionEnabled ? BADGE_COLOR : '#ccc',
              color: '#fff',
              border: 'none',
              borderRadius: 0,
              cursor: actionEnabled ? 'pointer' : 'not-allowed'
            }}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
