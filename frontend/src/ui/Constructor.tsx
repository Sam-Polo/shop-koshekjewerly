import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export type JewelryType = 'necklace' | 'earrings' | 'bracelet'

export type ConstructorBase = {
  id: string
  title: string
  description?: string
  image: string
  price: number
  /** 0 = без ограничения, N>0 = максимум подвесок */
  limit: number
}

export type ConstructorPendant = {
  id: string
  title: string
  description?: string
  image: string
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

type Step = 'type' | 'base' | 'pendants'

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

  // загрузка основ при выборе типа
  useEffect(() => {
    if (!selectedType) return
    setLoading(true)
    setError(null)
    fetch(`${apiUrl}/api/constructor/bases?type=${selectedType}`)
      .then(r => r.json())
      .then(data => setBases(data.bases || []))
      .catch(() => setError('Не удалось загрузить основы'))
      .finally(() => setLoading(false))
  }, [selectedType, apiUrl])

  // загрузка подвесок при переходе к шагу подвесок
  useEffect(() => {
    if (step !== 'pendants' || !selectedType) return
    setLoading(true)
    setError(null)
    fetch(`${apiUrl}/api/constructor/pendants?type=${selectedType}`)
      .then(r => r.json())
      .then(data => setPendants(data.pendants || []))
      .catch(() => setError('Не удалось загрузить подвески'))
      .finally(() => setLoading(false))
  }, [step, selectedType, apiUrl])

  const goBack = () => {
    setError(null)
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

  const handlePickBase = (b: ConstructorBase) => {
    setSelectedBase(b)
    setSelectedPendantIds([])
    setStep('pendants')
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

  const typeTitle = TYPES.find(t => t.key === selectedType)?.title ?? ''

  return (
    <motion.section
      className="constructor"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25 }}
      style={{ paddingBottom: selectedBase ? 140 : 24 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
        <button
          type="button"
          onClick={goBack}
          aria-label="Назад"
          style={{
            background: 'transparent',
            border: 'none',
            padding: 8,
            cursor: 'pointer',
            fontSize: 20,
            lineHeight: 1
          }}
        >
          ←
        </button>
        <h2 style={{ margin: 0, fontSize: 18 }}>
          {step === 'type' && 'Выберите тип украшения'}
          {step === 'base' && `${typeTitle}: выберите основу`}
          {step === 'pendants' && `${typeTitle}: выберите подвески${limit > 0 ? ` (до ${limit})` : ''}`}
        </h2>
      </div>

      {error && (
        <p style={{ padding: 16, color: '#c33' }}>{error}</p>
      )}

      <AnimatePresence mode="wait">
        {step === 'type' && (
          <motion.div
            key="type"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ display: 'grid', gap: 12, padding: 16 }}
          >
            {TYPES.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => handlePickType(t.key)}
                style={{
                  padding: '20px 16px',
                  fontSize: 16,
                  textAlign: 'left',
                  background: '#fff',
                  border: '1px solid #e8e8e8',
                  borderRadius: 12,
                  cursor: 'pointer'
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
            style={{ padding: 16 }}
          >
            {loading ? (
              <p style={{ textAlign: 'center', padding: 40 }}>Загрузка...</p>
            ) : bases.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: '#888' }}>
                Пока нет доступных основ для этого типа
              </p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {bases.map(b => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => handlePickBase(b)}
                    style={{
                      padding: 0,
                      background: '#fff',
                      border: '1px solid #e8e8e8',
                      borderRadius: 12,
                      cursor: 'pointer',
                      overflow: 'hidden',
                      textAlign: 'left'
                    }}
                  >
                    <div
                      style={{
                        width: '100%',
                        aspectRatio: '1 / 1',
                        backgroundImage: `url(${b.image})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        background: b.image ? `center / cover no-repeat url(${b.image})` : '#f4f4f4'
                      }}
                    />
                    <div style={{ padding: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{b.title}</div>
                      <div style={{ fontSize: 13, color: '#666' }}>{b.price} ₽</div>
                    </div>
                  </button>
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
            style={{ padding: 16 }}
          >
            {loading ? (
              <p style={{ textAlign: 'center', padding: 40 }}>Загрузка...</p>
            ) : pendants.length === 0 ? (
              <p style={{ textAlign: 'center', padding: 40, color: '#888' }}>
                Пока нет подвесок для этого типа
              </p>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {pendants.map(p => {
                  const selected = selectedPendantIds.includes(p.id)
                  const disabled = !selected && reachedLimit
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => !disabled && togglePendant(p.id)}
                      disabled={disabled}
                      style={{
                        padding: 0,
                        background: '#fff',
                        border: selected ? '2px solid #3942b8' : '1px solid #e8e8e8',
                        borderRadius: 12,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        overflow: 'hidden',
                        textAlign: 'left',
                        opacity: disabled ? 0.4 : 1,
                        transition: 'opacity 0.2s, border-color 0.2s'
                      }}
                    >
                      <div
                        style={{
                          width: '100%',
                          aspectRatio: '1 / 1',
                          background: p.image ? `center / cover no-repeat url(${p.image})` : '#f4f4f4'
                        }}
                      />
                      <div style={{ padding: 10 }}>
                        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{p.title}</div>
                        <div style={{ fontSize: 13, color: '#666' }}>{p.price} ₽</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sticky-превью внизу */}
      {selectedBase && (step === 'base' || step === 'pendants') && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            background: '#fff',
            borderTop: '1px solid #e8e8e8',
            padding: 12,
            boxShadow: '0 -4px 12px rgba(0,0,0,0.06)',
            zIndex: 100
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', overflowX: 'auto', marginBottom: 8 }}>
            <div
              style={{
                flexShrink: 0,
                width: 48,
                height: 48,
                borderRadius: 8,
                background: selectedBase.image ? `center / cover no-repeat url(${selectedBase.image})` : '#f4f4f4',
                border: '1px solid #e8e8e8'
              }}
              title={selectedBase.title}
            />
            {selectedPendantIds.map(id => {
              const p = pendants.find(x => x.id === id)
              if (!p) return null
              return (
                <div
                  key={id}
                  style={{
                    flexShrink: 0,
                    width: 48,
                    height: 48,
                    borderRadius: 8,
                    background: p.image ? `center / cover no-repeat url(${p.image})` : '#f4f4f4',
                    border: '1px solid #e8e8e8'
                  }}
                  title={p.title}
                />
              )
            })}
            <div style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 600, paddingRight: 8, whiteSpace: 'nowrap' }}>
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
              fontWeight: 500,
              background: canAddToCart ? '#000' : '#ccc',
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              cursor: canAddToCart ? 'pointer' : 'not-allowed'
            }}
          >
            {selectedPendantIds.length === 0
              ? 'Выберите минимум 1 подвеску'
              : 'В корзину'}
          </button>
        </div>
      )}
    </motion.section>
  )
}
