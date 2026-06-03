import { useEffect, useState } from 'react'
import { api, removeToken } from './api'
import type { AdminPage } from './BasesPage'
import './App.css'

type Customer = {
  id: string
  fullName: string
  phone: string
  username: string
  customerChatId: string
  platform: string
  ordersCount: number
  paidOrdersCount: number
  totalSpent: number
  firstOrderAt: string
  lastOrderAt: string
  lastAddress: string
  lastCity: string
  lastCountry: string
}

type CustomerOrder = {
  orderId: string
  createdAt: string
  status: string
  platform: string
  total: number
  itemsTotal: number
  deliveryCost: number
  promocodeCode: string
  promocodeDiscount: number
  adminNote: string
  clientComment: string
  items: { title: string; article: string; quantity: number; price: number; category: string }[]
}

function fmtMoney(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽'
}

function fmtDateTime(s: string): string {
  if (!s) return '—'
  const d = new Date(s)
  if (!Number.isFinite(d.getTime())) return s
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function platformLabel(p: string): string {
  if (p === 'max') return 'MAX'
  if (p === 'telegram') return 'Telegram'
  return p || '—'
}

function CustomerModal({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const [orders, setOrders] = useState<CustomerOrder[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.getCustomerOrders(customer.id)
      .then(d => setOrders(d.orders || []))
      .catch(() => setOrders([]))
      .finally(() => setLoading(false))
  }, [customer.id])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content stat-customer-modal" onClick={e => e.stopPropagation()}>
        <div className="stat-customer-header">
          <div>
            <h2>{customer.fullName || '—'}</h2>
            <div className="stat-muted">{customer.phone}{customer.username ? ` · ${customer.username}` : ''}</div>
            {customer.customerChatId && <div className="stat-muted">chat_id: {customer.customerChatId}</div>}
          </div>
          <button className="btn btn-cancel" onClick={onClose}>×</button>
        </div>

        <div className="stat-customer-summary">
          <div><span className="stat-muted">Платформа</span><span>{platformLabel(customer.platform)}</span></div>
          <div><span className="stat-muted">Заказов</span><span>{customer.ordersCount}{customer.ordersCount !== customer.paidOrdersCount ? ` (оплачено ${customer.paidOrdersCount})` : ''}</span></div>
          <div><span className="stat-muted">Потрачено</span><span><strong>{fmtMoney(customer.totalSpent)}</strong></span></div>
          <div><span className="stat-muted">Первый</span><span>{fmtDateTime(customer.firstOrderAt)}</span></div>
          <div><span className="stat-muted">Последний</span><span>{fmtDateTime(customer.lastOrderAt)}</span></div>
        </div>

        {customer.lastAddress && (
          <div className="stat-customer-address">
            <div className="stat-muted">Последний адрес</div>
            <div>{customer.lastCountry}, {customer.lastCity}</div>
            <div>{customer.lastAddress}</div>
          </div>
        )}

        <h3>Заказы клиента</h3>
        {loading ? <div className="loading">Загрузка...</div> : orders.length === 0 ? (
          <div className="stat-empty">Заказов не найдено</div>
        ) : (
          <div className="stat-customer-orders">
            {orders.map(o => (
              <div className="stat-customer-order" key={o.orderId}>
                <div className="stat-customer-order-head">
                  <div>
                    <code>{o.orderId}</code>
                    <span className={`stat-status stat-status-${o.status}`}>{o.status}</span>
                  </div>
                  <div className="stat-muted">{fmtDateTime(o.createdAt)} · {platformLabel(o.platform)}</div>
                  <strong>{fmtMoney(o.total)}</strong>
                </div>
                <div className="stat-customer-order-items">
                  {o.items.map((it, i) => (
                    <div key={i} className="stat-customer-order-item">
                      <span>{it.article ? `[${it.article}] ` : ''}{it.title}</span>
                      <span className="stat-muted">{it.category}</span>
                      <span>{it.quantity} × {fmtMoney(it.price)}</span>
                    </div>
                  ))}
                </div>
                {o.adminNote && <div className="stat-customer-order-note">📝 {o.adminNote}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function CustomersPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Customer | null>(null)

  useEffect(() => {
    setLoading(true)
    const timer = setTimeout(() => {
      api.getCustomers(search)
        .then(d => setCustomers(d.customers || []))
        .catch(() => setCustomers([]))
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [search])

  const handleLogout = () => { removeToken(); window.location.reload() }

  const navBtn = (page: AdminPage, label: string, isActive = false) => (
    <button className={`nav-btn${isActive ? ' active' : ''}`} onClick={() => onNavigate?.(page)}>{label}</button>
  )

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1>Админ-панель - KOSHEK JEWERLY</h1>
        <div className="header-nav">
          {navBtn('products', 'Товары')}
          {navBtn('promocodes', 'Промокоды')}
          {navBtn('categories', 'Категории')}
          {navBtn('bases', 'Конструктор')}
          {navBtn('statistics', 'Статистика')}
          {navBtn('customers', 'Клиенты', true)}
          {navBtn('settings', 'Настройки')}
        </div>
        <div className="header-actions">
          <button onClick={handleLogout} className="logout-btn">Выйти</button>
        </div>
      </header>

      <div className="stat-filters">
        <div className="stat-filter-group stat-filter-grow">
          <label>Поиск</label>
          <input
            type="text"
            placeholder="имя, телефон, username, chat_id, город..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="stat-period-hint">{customers.length} клиент(ов)</div>
      </div>

      {loading ? <div className="loading">Загрузка...</div> : customers.length === 0 ? (
        <div className="stat-empty">Клиенты не найдены</div>
      ) : (
        <div className="stat-orders-table">
          <table className="promocodes-table">
            <thead>
              <tr>
                <th>ФИО</th>
                <th>Контакты</th>
                <th>Платформа</th>
                <th>Заказов</th>
                <th>Потрачено</th>
                <th>Последний</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {customers.map(c => (
                <tr key={c.id} className="stat-order-row" style={{ cursor: 'pointer' }} onClick={() => setSelected(c)}>
                  <td><strong>{c.fullName || '—'}</strong></td>
                  <td>
                    <div>{c.phone || '—'}</div>
                    {c.username && <div className="stat-muted">{c.username}</div>}
                  </td>
                  <td>{platformLabel(c.platform)}</td>
                  <td>
                    {c.ordersCount}
                    {c.ordersCount !== c.paidOrdersCount && (
                      <span className="stat-muted"> ({c.paidOrdersCount} опл.)</span>
                    )}
                  </td>
                  <td><strong>{fmtMoney(c.totalSpent)}</strong></td>
                  <td>{fmtDateTime(c.lastOrderAt)}</td>
                  <td><button className="btn">Открыть</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <CustomerModal customer={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
