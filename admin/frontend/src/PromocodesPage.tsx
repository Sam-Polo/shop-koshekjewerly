import { useState, useEffect } from 'react'
import { api, removeToken } from './api'
import './App.css'

type Promocode = {
  code: string
  type: 'amount' | 'percent'
  value: number
  expiresAt?: string
  active: boolean
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
    expiresAt: ''
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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
        active: true // промокод всегда активен при создании
      })
      onSuccess()
    } catch (err: any) {
      setError(err.message || 'Ошибка создания промокода')
    } finally {
      setSaving(false)
    }
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
    </div>
  )
}

export default PromocodesPage

