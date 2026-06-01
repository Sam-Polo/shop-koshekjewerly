import { useState, useEffect } from 'react'
import { api, removeToken } from './api'
import type { AdminPage } from './BasesPage'
import './App.css'

type BannerStyle = 'pink' | 'gold' | 'neutral'

type BannerSettings = {
  bannerEnabled: boolean
  bannerText: string
  bannerStyle: BannerStyle
  bannerDateFrom: string
  bannerDateTo: string
}

type OrdersSettings = {
  ordersClosed: boolean
  closeDate: string
}

const STYLE_LABELS: Record<BannerStyle, string> = {
  pink: 'Розовый',
  gold: 'Золотой',
  neutral: 'Нейтральный',
}

const STYLE_PREVIEW: Record<BannerStyle, React.CSSProperties> = {
  pink: { background: '#d65baf', color: '#fff' },
  gold: { background: '#bf9243', color: '#fff' },
  neutral: { background: '#fae3f6', color: 'rgba(0,0,0,0.8)', border: '1px solid rgba(214,91,175,0.3)' },
}

function SettingsPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const handleLogout = () => {
    removeToken()
    window.location.href = '/'
  }

  // --- баннер ---
  const [banner, setBanner] = useState<BannerSettings>({
    bannerEnabled: false,
    bannerText: '',
    bannerStyle: 'neutral',
    bannerDateFrom: '',
    bannerDateTo: '',
  })
  const [bannerLoading, setBannerLoading] = useState(true)
  const [bannerSaving, setBannerSaving] = useState(false)

  // --- заказы ---
  const [orders, setOrders] = useState<OrdersSettings>({
    ordersClosed: false,
    closeDate: '',
  })
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [ordersSaving, setOrdersSaving] = useState(false)

  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type })
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    loadBanner()
    loadOrders()
  }, [])

  const loadBanner = async () => {
    try {
      setBannerLoading(true)
      const data = await api.getBannerSettings()
      setBanner({
        bannerEnabled: data.bannerEnabled || false,
        bannerText: data.bannerText || '',
        bannerStyle: data.bannerStyle || 'neutral',
        bannerDateFrom: data.bannerDateFrom || '',
        bannerDateTo: data.bannerDateTo || '',
      })
    } catch (err: any) {
      showToast(err.message || 'Ошибка загрузки баннера', 'error')
    } finally {
      setBannerLoading(false)
    }
  }

  const loadOrders = async () => {
    try {
      setOrdersLoading(true)
      const data = await api.getOrdersSettings()
      setOrders({
        ordersClosed: data.ordersClosed || false,
        closeDate: data.closeDate || '',
      })
    } catch (err: any) {
      showToast(err.message || 'Ошибка загрузки статуса заказов', 'error')
    } finally {
      setOrdersLoading(false)
    }
  }

  const handleSaveBanner = async () => {
    try {
      setBannerSaving(true)
      await api.updateBannerSettings({
        bannerEnabled: banner.bannerEnabled,
        bannerText: banner.bannerText,
        bannerStyle: banner.bannerStyle,
        bannerDateFrom: banner.bannerDateFrom || undefined,
        bannerDateTo: banner.bannerDateTo || undefined,
      })
      showToast('Баннер сохранён', 'success')
    } catch (err: any) {
      showToast(err.message || 'Ошибка сохранения баннера', 'error')
    } finally {
      setBannerSaving(false)
    }
  }

  const handleSaveOrders = async () => {
    try {
      setOrdersSaving(true)
      await api.updateOrdersSettings({
        ordersClosed: orders.ordersClosed,
        closeDate: orders.closeDate || undefined,
      })
      showToast(orders.ordersClosed ? 'Заказы закрыты' : 'Заказы открыты', 'success')
    } catch (err: any) {
      showToast(err.message || 'Ошибка сохранения статуса заказов', 'error')
    } finally {
      setOrdersSaving(false)
    }
  }

  return (
    <div className="admin-container">
      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.message}
          <button className="toast-close" onClick={() => setToast(null)}>&times;</button>
        </div>
      )}

      <header className="admin-header">
        <h1>Админ-панель - KOSHEK JEWERLY</h1>
        <div className="header-nav">
          <button className="nav-btn" onClick={() => onNavigate?.('products')}>Товары</button>
          <button className="nav-btn" onClick={() => onNavigate?.('promocodes')}>Промокоды</button>
          <button className="nav-btn" onClick={() => onNavigate?.('categories')}>Категории</button>
          <button className="nav-btn" onClick={() => onNavigate?.('bases')}>Конструктор</button>
          <button className="nav-btn" onClick={() => onNavigate?.('statistics')}>Статистика</button>
          <button className="nav-btn" onClick={() => onNavigate?.('customers')}>Клиенты</button>
          <button className="nav-btn active" onClick={() => onNavigate?.('settings')}>Настройки</button>
        </div>
        <button onClick={handleLogout} className="logout-btn">Выйти</button>
      </header>

      <div className="admin-content settings-page">

        {/* ── СТАТУС ЗАКАЗОВ ─────────────────────────────── */}
        <section className="settings-section">
          <h2 className="settings-section__title">Статус заказов</h2>
          {ordersLoading ? (
            <div className="settings-loading">Загрузка...</div>
          ) : (
            <div className="settings-card">
              <label className="settings-toggle-row">
                <span className="settings-toggle-label">
                  Заказы закрыты
                  <span className={`settings-status-badge ${orders.ordersClosed ? 'badge-closed' : 'badge-open'}`}>
                    {orders.ordersClosed ? 'Закрыты' : 'Открыты'}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="settings-toggle-input"
                  checked={orders.ordersClosed}
                  onChange={e => setOrders(prev => ({ ...prev, ordersClosed: e.target.checked }))}
                />
                <span className="settings-toggle-slider" />
              </label>

              <div className="settings-field">
                <label className="settings-label">Дата открытия (необязательно)</label>
                <input
                  type="date"
                  className="settings-input"
                  value={orders.closeDate}
                  onChange={e => setOrders(prev => ({ ...prev, closeDate: e.target.value }))}
                />
                <p className="settings-hint">Отображается в мини-приложении как «до&nbsp;[дата]»</p>
              </div>

              <button
                className="settings-save-btn"
                onClick={handleSaveOrders}
                disabled={ordersSaving}
              >
                {ordersSaving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          )}
        </section>

        {/* ── БАННЕР ─────────────────────────────────────── */}
        <section className="settings-section">
          <h2 className="settings-section__title">Информационный баннер</h2>
          {bannerLoading ? (
            <div className="settings-loading">Загрузка...</div>
          ) : (
            <div className="settings-card">
              <label className="settings-toggle-row">
                <span className="settings-toggle-label">
                  Показывать баннер
                  <span className={`settings-status-badge ${banner.bannerEnabled ? 'badge-open' : 'badge-closed'}`}>
                    {banner.bannerEnabled ? 'Включён' : 'Выключен'}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="settings-toggle-input"
                  checked={banner.bannerEnabled}
                  onChange={e => setBanner(prev => ({ ...prev, bannerEnabled: e.target.checked }))}
                />
                <span className="settings-toggle-slider" />
              </label>

              <div className="settings-field">
                <label className="settings-label">Текст баннера</label>
                <textarea
                  className="settings-textarea"
                  rows={3}
                  placeholder="Например: Сроки сборки увеличены до 14 дней"
                  value={banner.bannerText}
                  onChange={e => setBanner(prev => ({ ...prev, bannerText: e.target.value }))}
                />
              </div>

              <div className="settings-field">
                <label className="settings-label">Стиль</label>
                <div className="settings-style-grid">
                  {(['pink', 'gold', 'neutral'] as BannerStyle[]).map(style => (
                    <label
                      key={style}
                      className={`settings-style-option ${banner.bannerStyle === style ? 'selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name="bannerStyle"
                        value={style}
                        checked={banner.bannerStyle === style}
                        onChange={() => setBanner(prev => ({ ...prev, bannerStyle: style }))}
                      />
                      <span
                        className="settings-style-preview"
                        style={STYLE_PREVIEW[style]}
                      >
                        {STYLE_LABELS[style]}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="settings-field-row">
                <div className="settings-field">
                  <label className="settings-label">Показывать с</label>
                  <input
                    type="date"
                    className="settings-input"
                    value={banner.bannerDateFrom}
                    onChange={e => setBanner(prev => ({ ...prev, bannerDateFrom: e.target.value }))}
                  />
                </div>
                <div className="settings-field">
                  <label className="settings-label">Показывать по</label>
                  <input
                    type="date"
                    className="settings-input"
                    value={banner.bannerDateTo}
                    onChange={e => setBanner(prev => ({ ...prev, bannerDateTo: e.target.value }))}
                  />
                </div>
              </div>
              <p className="settings-hint">Даты необязательны. Если заданы — баннер скрывается автоматически вне диапазона.</p>

              {/* превью */}
              {banner.bannerText && (
                <div className="settings-banner-preview">
                  <p className="settings-label">Предпросмотр</p>
                  <div
                    className="settings-banner-preview-strip"
                    style={STYLE_PREVIEW[banner.bannerStyle]}
                  >
                    {banner.bannerText}
                  </div>
                </div>
              )}

              <button
                className="settings-save-btn"
                onClick={handleSaveBanner}
                disabled={bannerSaving}
              >
                {bannerSaving ? 'Сохранение...' : 'Сохранить баннер'}
              </button>
            </div>
          )}
        </section>

      </div>
    </div>
  )
}

export default SettingsPage
