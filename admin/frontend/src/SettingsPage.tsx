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
  assemblyMessage: string
  trackMessage: string
  shippedMessage: string
  priorityOrderEnabled: boolean
  priorityOrderFee: number
}

type MessageTab = 'order_confirmed' | 'track_assigned' | 'shipped'

const STYLE_LABELS: Record<BannerStyle, string> = {
  pink: 'Розовый',
  gold: 'Золотой',
  neutral: 'Нейтральный',
}

// стили кнопок-пресетов (на светлом фоне карточки)
const STYLE_CHIP: Record<BannerStyle, React.CSSProperties> = {
  pink: { background: 'rgba(214,91,175,0.15)', color: '#b03a8e', border: '1px solid rgba(214,91,175,0.4)' },
  gold: { background: 'rgba(191,146,67,0.15)', color: '#7a5c1e', border: '1px solid rgba(191,146,67,0.4)' },
  neutral: { background: 'rgba(0,0,0,0.05)', color: '#555', border: '1px solid rgba(0,0,0,0.15)' },
}

// превью — имитируем тёмный hero-фон
const STYLE_PREVIEW_STRIP: Record<BannerStyle, React.CSSProperties> = {
  pink: { background: 'rgba(214,91,175,0.28)', border: '1px solid rgba(214,91,175,0.55)', color: '#fff' },
  gold: { background: 'rgba(191,146,67,0.28)', border: '1px solid rgba(191,146,67,0.60)', color: '#fff' },
  neutral: { background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.28)', color: '#fff' },
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
    assemblyMessage: '',
    trackMessage: '',
    shippedMessage: '',
    priorityOrderEnabled: true,
    priorityOrderFee: 30,
  })
  const [messageTab, setMessageTab] = useState<MessageTab>('order_confirmed')
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
        assemblyMessage: data.assemblyMessage || '',
        trackMessage: data.trackMessage || '',
        shippedMessage: data.shippedMessage || '',
        priorityOrderEnabled: data.priorityOrderEnabled !== false,
        priorityOrderFee: data.priorityOrderFee ?? 30,
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
        assemblyMessage: orders.assemblyMessage || undefined,
        trackMessage: orders.trackMessage || undefined,
        shippedMessage: orders.shippedMessage || undefined,
        priorityOrderEnabled: orders.priorityOrderEnabled,
        priorityOrderFee: orders.priorityOrderFee,
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
          <button className="nav-btn" onClick={() => onNavigate?.('shipments')}>Учёт</button>
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

        {/* ── СООБЩЕНИЯ БОТА ────────────────────────────── */}
        <section className="settings-section">
          <h2 className="settings-section__title">Сообщения бота</h2>
          {ordersLoading ? (
            <div className="settings-loading">Загрузка...</div>
          ) : (
            <div className="settings-card">
              <div className="msg-tabs">
                <button
                  className={`msg-tab${messageTab === 'order_confirmed' ? ' msg-tab--active' : ''}`}
                  onClick={() => setMessageTab('order_confirmed')}
                >
                  1. Заказ оформлен
                </button>
                <button
                  className={`msg-tab${messageTab === 'track_assigned' ? ' msg-tab--active' : ''}`}
                  onClick={() => setMessageTab('track_assigned')}
                >
                  2. Трек назначен
                </button>
                <button
                  className={`msg-tab${messageTab === 'shipped' ? ' msg-tab--active' : ''}`}
                  onClick={() => setMessageTab('shipped')}
                >
                  3. Отправлен
                </button>
              </div>

              {messageTab === 'order_confirmed' && (
                <div className="settings-field">
                  <label className="settings-label">Блок о сроках сборки</label>
                  <textarea
                    className="settings-textarea"
                    rows={3}
                    placeholder="Ваш заказ будет отправлен в течении 3-5 дней, мы пришлем уведомление с трек номером для отслеживания. Благодарим за заказ 🤍"
                    value={orders.assemblyMessage}
                    onChange={e => setOrders(prev => ({ ...prev, assemblyMessage: e.target.value }))}
                  />
                  <p className="settings-hint">
                    Вставляется в конец сообщения «🎉 Ваш заказ оформлен!» после блока доставки.
                    Если оставить пустым — используется стандартный текст. Плейсхолдеры не поддерживаются.
                  </p>
                </div>
              )}

              {messageTab === 'track_assigned' && (
                <div className="settings-field">
                  <label className="settings-label">Текст сообщения с трек-номером</label>
                  <textarea
                    className="settings-textarea"
                    rows={5}
                    placeholder={'🩷 Ваша посылочка скоро уедет к вам.\nОтследить можно по ссылке:\n\n{{track-link}}\n\nСпасибо за заказ, всегда будем счастливы видеть ваши отзывы 🥰'}
                    value={orders.trackMessage}
                    onChange={e => setOrders(prev => ({ ...prev, trackMessage: e.target.value }))}
                  />
                  <p className="settings-hint">
                    Отправляется покупателю сразу после оформления заказа — когда СДЭК или Почта России создала отправление.
                    Плейсхолдеры: <b>{'{{track}}'}</b> — трек-номер, <b>{'{{track-link}}'}</b> — ссылка на отслеживание, <b>{'{{ord}}'}</b> — номер заказа.
                    Поддерживаются HTML-теги Telegram: <b>&lt;b&gt;</b>, <b>&lt;i&gt;</b>, <b>&lt;code&gt;</b>.
                    Если оставить пустым — используется стандартный текст.
                  </p>
                </div>
              )}

              {messageTab === 'shipped' && (
                <div className="settings-field">
                  <label className="settings-label">Текст уведомления об отправке</label>
                  <textarea
                    className="settings-textarea"
                    rows={5}
                    placeholder={'📦 Ваш заказ отправлен!\n\nОтследить посылку:\n{{track-link}}\n\nСпасибо за ваш заказ 🤍'}
                    value={orders.shippedMessage}
                    onChange={e => setOrders(prev => ({ ...prev, shippedMessage: e.target.value }))}
                  />
                  <p className="settings-hint">
                    Отправляется через кнопку «Отбить» в разделе Заказы или автоматически от СДЭК (статус RECEIVED_AT_SENDER_CITY).
                    Плейсхолдеры: <b>{'{{track}}'}</b> — трек-номер, <b>{'{{track-link}}'}</b> — ссылка на отслеживание, <b>{'{{ord}}'}</b> — номер заказа.
                    Поддерживаются HTML-теги Telegram: <b>&lt;b&gt;</b>, <b>&lt;i&gt;</b>, <b>&lt;code&gt;</b>.
                    Если оставить пустым — используется стандартный текст.
                  </p>
                </div>
              )}

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

        {/* ── ПРИОРИТЕТНЫЙ ЗАКАЗ ────────────────────────── */}
        <section className="settings-section">
          <h2 className="settings-section__title">Приоритетный заказ</h2>
          {ordersLoading ? (
            <div className="settings-loading">Загрузка...</div>
          ) : (
            <div className="settings-card">
              <label className="settings-toggle-row">
                <span className="settings-toggle-label">
                  Показывать плашку
                  <span className={`settings-status-badge ${orders.priorityOrderEnabled ? 'badge-open' : 'badge-closed'}`}>
                    {orders.priorityOrderEnabled ? 'Включена' : 'Выключена'}
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="settings-toggle-input"
                  checked={orders.priorityOrderEnabled}
                  onChange={e => setOrders(prev => ({ ...prev, priorityOrderEnabled: e.target.checked }))}
                />
                <span className="settings-toggle-slider" />
              </label>
              <p className="settings-hint" style={{ marginTop: '-0.75rem' }}>При выключении плашка «Приоритетный заказ» полностью скрывается в форме оформления заказа.</p>

              <div className="settings-field">
                <label className="settings-label">Наценка за приоритет (%)</label>
                <input
                  type="number"
                  className="settings-input"
                  min={1}
                  max={100}
                  value={orders.priorityOrderFee}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10)
                    if (!isNaN(v) && v >= 1 && v <= 100) setOrders(prev => ({ ...prev, priorityOrderFee: v }))
                  }}
                  style={{ maxWidth: 100 }}
                />
                <p className="settings-hint">Процент, который прибавляется к сумме заказа при включённом приоритете. Сейчас: <b>+{orders.priorityOrderFee}%</b></p>
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
                        style={STYLE_CHIP[style]}
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

              {/* превью на тёмном фоне — имитация hero */}
              {banner.bannerText && (
                <div className="settings-banner-preview">
                  <p className="settings-label">Предпросмотр</p>
                  <div className="settings-banner-preview-bg">
                    <div
                      className="settings-banner-preview-strip"
                      style={STYLE_PREVIEW_STRIP[banner.bannerStyle]}
                    >
                      {banner.bannerText}
                    </div>
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
