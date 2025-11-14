import { useState, useEffect } from 'react'
import { api, removeToken } from './api'
import './App.css'

type Promocode = {
  code: string
  type: 'amount' | 'percent'
  value: number
  expiresAt?: string
  active: boolean
  productSlugs?: string[]
}

type Product = {
  slug: string
  title: string
  category: string
}

function PromocodesPage({ onNavigate }: { onNavigate?: (page: 'products' | 'promocodes') => void }) {
  const handleLogout = () => {
    removeToken()
    window.location.href = '/'
  }
  const [promocodes, setPromocodes] = useState<Promocode[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ code: string } | null>(null)
  const [isAddModalOpen, setIsAddModalOpen] = useState(false)

  useEffect(() => {
    loadPromocodes()
  }, [])

  const loadPromocodes = async () => {
    try {
      setLoading(true)
      const data = await api.getPromocodes()
      setPromocodes(data.promocodes || [])
    } catch (error: any) {
      showToast(error.message || 'Ошибка загрузки промокодов', 'error')
    } finally {
      setLoading(false)
    }
  }

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type })
  }

  const handleDelete = async (code: string) => {
    try {
      await api.deletePromocode(code)
      showToast('Промокод удален', 'success')
      loadPromocodes()
    } catch (error: any) {
      showToast(error.message || 'Ошибка удаления промокода', 'error')
    } finally {
      setDeleteConfirm(null)
    }
  }

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '—'
    try {
      const date = new Date(dateStr)
      return new Intl.DateTimeFormat('ru-RU', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Moscow'
      }).format(date)
    } catch {
      return dateStr
    }
  }

  const isExpired = (expiresAt?: string) => {
    if (!expiresAt) return false
    return new Date(expiresAt) < new Date()
  }

  if (loading) {
    return <div className="loading">Загрузка...</div>
  }

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1>Админ-панель - KOSHEK JEWERLY</h1>
        <div className="header-nav">
          <button 
            className="nav-btn"
            onClick={() => onNavigate?.('products')}
          >
            Товары
          </button>
          <button 
            className="nav-btn active"
            onClick={() => onNavigate?.('promocodes')}
          >
            Промокоды
          </button>
        </div>
        <div className="header-actions">
          <button className="btn btn-add" onClick={() => setIsAddModalOpen(true)}>
            + Добавить промокод
          </button>
          <button onClick={handleLogout} className="logout-btn">
            Выйти
          </button>
        </div>
      </header>

      <div className="promocodes-list">
        {promocodes.length === 0 ? (
          <div className="empty-state">Промокоды не найдены</div>
        ) : (
          <table className="promocodes-table">
            <thead>
              <tr>
                <th>Код</th>
                <th>Тип</th>
                <th>Значение</th>
                <th>Товары</th>
                <th>Окончание</th>
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {promocodes.map((promocode) => {
                const expired = isExpired(promocode.expiresAt)
                const status = !promocode.active ? 'Неактивен' : expired ? 'Истек' : 'Активен'
                
                return (
                  <tr key={promocode.code} className={!promocode.active || expired ? 'inactive' : ''}>
                    <td><strong>{promocode.code}</strong></td>
                    <td>{promocode.type === 'amount' ? 'Сумма' : 'Процент'}</td>
                    <td>
                      {promocode.type === 'amount' 
                        ? `${promocode.value} ₽` 
                        : `${promocode.value}%`}
                    </td>
                    <td>
                      {promocode.productSlugs === undefined || promocode.productSlugs.length === 0
                        ? <span style={{ color: '#666' }}>Все товары</span>
                        : <span title={promocode.productSlugs.join(', ')}>{promocode.productSlugs.length} товар(ов)</span>}
                    </td>
                    <td>{formatDate(promocode.expiresAt)}</td>
                    <td>{status}</td>
                    <td>
                      <button
                        className="btn btn-delete"
                        onClick={() => setDeleteConfirm({ code: promocode.code })}
                      >
                        Удалить
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {isAddModalOpen && (
        <PromocodeFormModal
          onClose={() => setIsAddModalOpen(false)}
          onSuccess={() => {
            setIsAddModalOpen(false)
            loadPromocodes()
            showToast('Промокод создан', 'success')
          }}
        />
      )}

      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal-content confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Подтверждение</h3>
            <p>Удалить промокод <strong>{deleteConfirm.code}</strong>?</p>
            <div className="confirm-actions">
              <button onClick={() => setDeleteConfirm(null)} className="btn btn-cancel">
                Отмена
              </button>
              <button onClick={() => handleDelete(deleteConfirm.code)} className="btn btn-confirm">
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
          <button className="toast-close" onClick={() => setToast(null)}>&times;</button>
        </div>
      )}
    </div>
  )
}

function PromocodeFormModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [formData, setFormData] = useState({
    code: '',
    type: 'amount' as 'amount' | 'percent',
    value: '',
    expiresAt: '',
    productSlugs: undefined as string[] | undefined
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [isProductSelectorOpen, setIsProductSelectorOpen] = useState(false)
  const [products, setProducts] = useState<Product[]>([])
  const [productsLoading, setProductsLoading] = useState(false)
  const [productSearch, setProductSearch] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const value = Number(formData.value)
    if (!formData.code.trim()) {
      setError('Введите код промокода')
      return
    }
    if (formData.code.trim().length < 3 || formData.code.trim().length > 50) {
      setError('Код должен быть от 3 до 50 символов')
      return
    }
    if (!/^[A-Z0-9_-]+$/i.test(formData.code.trim())) {
      setError('Код может содержать только буквы, цифры, дефисы и подчеркивания')
      return
    }
    if (!value || value <= 0) {
      setError('Введите корректное значение')
      return
    }
    if (formData.type === 'percent' && value > 100) {
      setError('Процент не может быть больше 100')
      return
    }

    try {
      setSaving(true)
      await api.createPromocode({
        code: formData.code.trim().toUpperCase(),
        type: formData.type,
        value,
        expiresAt: formData.expiresAt || undefined,
        active: true, // промокод всегда активен при создании
        productSlugs: formData.productSlugs && formData.productSlugs.length > 0 ? formData.productSlugs : undefined
      })
      onSuccess()
    } catch (err: any) {
      setError(err.message || 'Ошибка создания промокода')
    } finally {
      setSaving(false)
    }
  }

  // загрузка товаров для выбора
  useEffect(() => {
    if (isProductSelectorOpen && products.length === 0) {
      loadProducts()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProductSelectorOpen])

  const loadProducts = async () => {
    try {
      setProductsLoading(true)
      const data = await api.getProducts()
      const productsList = (data.products || []).map((p: any) => ({
        slug: p.slug,
        title: p.title,
        category: p.category
      }))
      setProducts(productsList)
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки товаров')
    } finally {
      setProductsLoading(false)
    }
  }

  // фильтрация товаров по поиску
  const filteredProducts = products.filter(p => {
    const searchLower = productSearch.toLowerCase()
    return p.title.toLowerCase().includes(searchLower) || 
           p.slug.toLowerCase().includes(searchLower) ||
           p.category.toLowerCase().includes(searchLower)
  })

  const handleProductToggle = (slug: string) => {
    setFormData(prev => {
      const current = prev.productSlugs || []
      if (current.includes(slug)) {
        return { ...prev, productSlugs: current.filter(s => s !== slug) }
      } else {
        return { ...prev, productSlugs: [...current, slug] }
      }
    })
  }

  const handleSelectAllProducts = () => {
    setFormData(prev => ({ ...prev, productSlugs: undefined }))
  }

  // получение текущей даты и времени в московском времени для минимального значения
  const getMinDateTime = () => {
    const now = new Date()
    const moscowOffset = 3 * 60 // UTC+3 в минутах
    const moscowTime = new Date(now.getTime() + (moscowOffset - now.getTimezoneOffset()) * 60000)
    return moscowTime.toISOString().slice(0, 16)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <h2>Добавить промокод</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Код промокода *</label>
            <input
              type="text"
              value={formData.code}
              onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
              placeholder="PROMO2024"
              maxLength={50}
              required
            />
            <small>Только буквы, цифры, дефисы и подчеркивания</small>
          </div>

          <div className="form-group">
            <label>Тип *</label>
            <select
              value={formData.type}
              onChange={(e) => setFormData({ ...formData, type: e.target.value as 'amount' | 'percent' })}
              required
            >
              <option value="amount">Сумма (₽)</option>
              <option value="percent">Процент (%)</option>
            </select>
          </div>

          <div className="form-group">
            <label>Значение *</label>
            <input
              type="number"
              step={formData.type === 'percent' ? '0.01' : '1'}
              min="0"
              max={formData.type === 'percent' ? '100' : undefined}
              value={formData.value}
              onChange={(e) => setFormData({ ...formData, value: e.target.value })}
              placeholder={formData.type === 'amount' ? '500' : '10'}
              required
            />
            <small>{formData.type === 'amount' ? 'Сумма в рублях' : 'Процент от 0 до 100'}</small>
          </div>

          <div className="form-group">
            <label>Дата и время окончания (МСК)</label>
            <input
              type="datetime-local"
              value={formData.expiresAt}
              onChange={(e) => setFormData({ ...formData, expiresAt: e.target.value })}
              min={getMinDateTime()}
            />
            <small>Оставьте пустым, если промокод без срока действия. Промокод будет активен до указанной даты.</small>
          </div>

          <div className="form-group">
            <label>Товары</label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setIsProductSelectorOpen(true)}
                className="btn"
                style={{ flexShrink: 0 }}
              >
                {formData.productSlugs === undefined 
                  ? 'Все товары' 
                  : formData.productSlugs.length === 0
                  ? 'Назначить товары'
                  : `Выбрано: ${formData.productSlugs.length}`}
              </button>
              {formData.productSlugs !== undefined && formData.productSlugs.length > 0 && (
                <button
                  type="button"
                  onClick={handleSelectAllProducts}
                  className="btn btn-cancel"
                  style={{ fontSize: '0.875rem', padding: '0.5rem 1rem' }}
                >
                  Сбросить (все товары)
                </button>
              )}
            </div>
            <small>
              {formData.productSlugs === undefined 
                ? 'Промокод действует на все товары' 
                : formData.productSlugs.length === 0
                ? 'Нажмите "Назначить товары" чтобы выбрать конкретные товары'
                : `Промокод действует только на ${formData.productSlugs.length} выбранных товаров`}
            </small>
          </div>

          {error && (
            <div style={{ background: '#fee', color: '#c33', padding: '0.75rem', borderRadius: '4px' }}>
              {error}
            </div>
          )}

          <div className="form-actions">
            <button type="button" onClick={onClose} className="btn btn-cancel" disabled={saving}>
              Отмена
            </button>
            <button type="submit" className="btn btn-save" disabled={saving}>
              {saving ? 'Создание...' : 'Создать'}
            </button>
          </div>
        </form>
      </div>

      {isProductSelectorOpen && (
        <div className="modal-overlay" onClick={() => setIsProductSelectorOpen(false)} style={{ zIndex: 10001 }}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h2>Выбор товаров</h2>
            
            <div style={{ marginBottom: '1rem' }}>
              <input
                type="text"
                placeholder="Поиск по названию, slug или категории..."
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                style={{ width: '100%', padding: '0.75rem', border: '1px solid #ddd', borderRadius: '4px' }}
              />
            </div>

            {productsLoading ? (
              <div className="loading">Загрузка товаров...</div>
            ) : (
              <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #eee', borderRadius: '4px', padding: '0.5rem' }}>
                {filteredProducts.length === 0 ? (
                  <div style={{ padding: '2rem', textAlign: 'center', color: '#666' }}>
                    {productSearch ? 'Товары не найдены' : 'Нет товаров'}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {filteredProducts.map(product => {
                      const isSelected = formData.productSlugs?.includes(product.slug) || false
                      return (
                        <label
                          key={product.slug}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0.75rem',
                            border: `1px solid ${isSelected ? '#ec4899' : '#eee'}`,
                            borderRadius: '4px',
                            cursor: 'pointer',
                            backgroundColor: isSelected ? 'rgba(236, 72, 153, 0.05)' : 'white',
                            transition: 'all 0.2s'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleProductToggle(product.slug)}
                            style={{ marginRight: '0.75rem', width: '18px', height: '18px', cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 500 }}>{product.title}</div>
                            <div style={{ fontSize: '0.875rem', color: '#666', marginTop: '0.25rem' }}>
                              {product.category} • {product.slug}
                            </div>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setIsProductSelectorOpen(false)}
                className="btn btn-save"
              >
                Готово
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default PromocodesPage

