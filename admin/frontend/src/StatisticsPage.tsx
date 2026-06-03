import { useEffect, useMemo, useState } from 'react'
import { api, removeToken } from './api'
import type { AdminPage } from './BasesPage'
import './App.css'

type Tab = 'overview' | 'orders'

type OrderItem = {
  orderId: string
  slug: string
  title: string
  price: number
  quantity: number
  article: string
  category: string
}

type Order = {
  orderId: string
  createdAt: string
  updatedAt: string
  status: string
  platform: string
  customerChatId: string
  customerName: string
  fullName: string
  phone: string
  username: string
  country: string
  city: string
  address: string
  deliveryRegion: string
  deliveryCost: number
  itemsTotal: number
  promocodeCode: string
  promocodeDiscount: number
  priorityOrder: boolean
  priorityFee: number
  total: number
  clientComment: string
  adminNote: string
  items: OrderItem[]
}

type StatsResponse = {
  kpi: { revenue: number; ordersCount: number; avgCheck: number }
  timeline: { date: string; revenue: number; orders: number }[]
  byPlatform: { platform: string; revenue: number; orders: number }[]
  byCategory: { category: string; revenue: number; quantity: number }[]
  topProducts: { slug: string; title: string; article: string; revenue: number; quantity: number; category: string }[]
}

type Preset = '7' | '30' | '90' | 'all' | 'custom'

function isoFromDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString()
}

function endOfTodayIso(): string {
  const d = new Date()
  d.setUTCHours(23, 59, 59, 999)
  return d.toISOString()
}

function isoToDate(s: string): string {
  if (!s) return ''
  return s.slice(0, 10)
}

function dateToIso(s: string, end: boolean): string {
  if (!s) return ''
  const d = new Date(s + (end ? 'T23:59:59Z' : 'T00:00:00Z'))
  return d.toISOString()
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

const PLATFORM_COLORS: Record<string, string> = {
  telegram: '#2AABEE',
  max: '#7c3aed'
}

const CATEGORY_PALETTE = ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b', '#fa709a', '#feb47b', '#30cfd0', '#a8edea', '#fed6e3']

// ──────────────────────────────────────────────────────────────────────────
// Subcomponents
// ──────────────────────────────────────────────────────────────────────────

function NavBar({ active, onNavigate, onLogout }: { active: 'statistics' | 'customers'; onNavigate?: (page: AdminPage) => void; onLogout: () => void }) {
  const navBtn = (page: AdminPage, label: string, isActive = false) => (
    <button className={`nav-btn${isActive ? ' active' : ''}`} onClick={() => onNavigate?.(page)}>{label}</button>
  )
  return (
    <header className="admin-header">
      <h1>Админ-панель - KOSHEK JEWERLY</h1>
      <div className="header-nav">
        {navBtn('products', 'Товары')}
        {navBtn('promocodes', 'Промокоды')}
        {navBtn('categories', 'Категории')}
        {navBtn('bases', 'Конструктор')}
        {navBtn('statistics', 'Статистика', active === 'statistics')}
        {navBtn('customers', 'Клиенты', active === 'customers')}
        {navBtn('settings', 'Настройки')}
      </div>
      <div className="header-actions">
        <button onClick={onLogout} className="logout-btn">Выйти</button>
      </div>
    </header>
  )
}

function KpiCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="stat-kpi-card">
      <div className="stat-kpi-title">{title}</div>
      <div className="stat-kpi-value">{value}</div>
    </div>
  )
}

function LineChart({ data, valueKey, color, label }: { data: { date: string; revenue: number; orders: number }[]; valueKey: 'revenue' | 'orders'; color: string; label: string }) {
  const W = 720, H = 220, PAD_L = 50, PAD_R = 16, PAD_T = 16, PAD_B = 30
  if (!data.length) {
    return <div className="stat-empty">Нет данных за выбранный период</div>
  }
  const values = data.map(d => d[valueKey])
  const maxV = Math.max(1, ...values)
  const minV = 0
  const xStep = (W - PAD_L - PAD_R) / Math.max(1, data.length - 1)
  const yFor = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - minV) / (maxV - minV))
  const xFor = (i: number) => PAD_L + i * xStep
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(d[valueKey])}`).join(' ')
  const area = path + ` L ${xFor(data.length - 1)} ${H - PAD_B} L ${xFor(0)} ${H - PAD_B} Z`
  const yTicks = 4
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => Math.round(minV + ((maxV - minV) * i) / yTicks))
  const xLabelEvery = Math.max(1, Math.ceil(data.length / 8))
  return (
    <div className="stat-chart-wrap">
      <div className="stat-chart-title">{label}</div>
      <svg className="stat-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${valueKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD_L} y1={yFor(t)} x2={W - PAD_R} y2={yFor(t)} stroke="#eee" />
            <text x={PAD_L - 8} y={yFor(t) + 4} textAnchor="end" fontSize="11" fill="#888">{valueKey === 'revenue' ? Math.round(t / 1000) + 'k' : t}</text>
          </g>
        ))}
        <path d={area} fill={`url(#grad-${valueKey})`} />
        <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <circle key={i} cx={xFor(i)} cy={yFor(d[valueKey])} r="3" fill={color}>
            <title>{`${d.date}: ${valueKey === 'revenue' ? fmtMoney(d.revenue) : d.orders + ' заказ(ов)'}`}</title>
          </circle>
        ))}
        {data.map((d, i) => i % xLabelEvery === 0 ? (
          <text key={i} x={xFor(i)} y={H - 10} textAnchor="middle" fontSize="11" fill="#888">{d.date.slice(5)}</text>
        ) : null)}
      </svg>
    </div>
  )
}

function HorizontalBars({ items, title, emptyText }: { items: { label: string; value: number; sub?: string; color?: string }[]; title: string; emptyText: string }) {
  if (!items.length) return <div className="stat-empty">{emptyText}</div>
  const max = Math.max(1, ...items.map(i => i.value))
  return (
    <div className="stat-bars-wrap">
      <div className="stat-chart-title">{title}</div>
      <div className="stat-bars-list">
        {items.map((it, i) => {
          const w = (it.value / max) * 100
          const color = it.color || CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]
          return (
            <div className="stat-bar-row" key={i}>
              <div className="stat-bar-label" title={it.label}>{it.label}</div>
              <div className="stat-bar-track">
                <div className="stat-bar-fill" style={{ width: `${w}%`, background: color }} />
                <div className="stat-bar-value">{fmtMoney(it.value)}{it.sub ? <span className="stat-bar-sub"> · {it.sub}</span> : null}</div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Donut({ items, title }: { items: { label: string; value: number; color: string }[]; title: string }) {
  const total = items.reduce((s, i) => s + i.value, 0)
  if (total === 0) return <div className="stat-empty">Нет данных</div>
  const R = 70, r = 45, CX = 90, CY = 90
  let angle = -Math.PI / 2
  const arcs = items.map((it) => {
    const frac = it.value / total
    const a1 = angle
    const a2 = angle + frac * Math.PI * 2
    angle = a2
    const large = frac > 0.5 ? 1 : 0
    const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1)
    const x2 = CX + R * Math.cos(a2), y2 = CY + R * Math.sin(a2)
    const x3 = CX + r * Math.cos(a2), y3 = CY + r * Math.sin(a2)
    const x4 = CX + r * Math.cos(a1), y4 = CY + r * Math.sin(a1)
    const d = `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${large} 0 ${x4} ${y4} Z`
    return { d, color: it.color, label: it.label, value: it.value, pct: Math.round(frac * 100) }
  })
  return (
    <div className="stat-donut-wrap">
      <div className="stat-chart-title">{title}</div>
      <div className="stat-donut-row">
        <svg width="180" height="180" viewBox="0 0 180 180">
          {arcs.map((a, i) => <path key={i} d={a.d} fill={a.color}><title>{`${a.label}: ${fmtMoney(a.value)} (${a.pct}%)`}</title></path>)}
          <text x={CX} y={CY - 4} textAnchor="middle" fontSize="13" fill="#666">всего</text>
          <text x={CX} y={CY + 14} textAnchor="middle" fontSize="15" fontWeight="600" fill="#333">{fmtMoney(total)}</text>
        </svg>
        <div className="stat-donut-legend">
          {arcs.map((a, i) => (
            <div key={i} className="stat-donut-legend-row">
              <span className="stat-donut-dot" style={{ background: a.color }} />
              <span className="stat-donut-label">{a.label}</span>
              <span className="stat-donut-value">{fmtMoney(a.value)} · {a.pct}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Overview tab
// ──────────────────────────────────────────────────────────────────────────

function OverviewTab({ stats, loading }: { stats: StatsResponse | null; loading: boolean }) {
  if (loading) return <div className="loading">Загрузка статистики...</div>
  if (!stats) return <div className="stat-empty">Нет данных</div>
  const platformItems = stats.byPlatform.map(p => ({
    label: platformLabel(p.platform),
    value: p.revenue,
    color: PLATFORM_COLORS[p.platform] || '#888'
  }))
  return (
    <div className="stat-overview">
      <div className="stat-kpi-row">
        <KpiCard title="Выручка" value={fmtMoney(stats.kpi.revenue)} />
        <KpiCard title="Заказов" value={String(stats.kpi.ordersCount)} />
        <KpiCard title="Средний чек" value={fmtMoney(stats.kpi.avgCheck)} />
      </div>
      <div className="stat-grid-2">
        <LineChart data={stats.timeline} valueKey="revenue" color="#667eea" label="Выручка по дням" />
        <LineChart data={stats.timeline} valueKey="orders" color="#43e97b" label="Заказы по дням" />
      </div>
      <div className="stat-grid-2">
        <HorizontalBars
          items={stats.byCategory.map((c, i) => ({ label: c.category, value: c.revenue, sub: `${c.quantity} шт`, color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length] }))}
          title="Категории по выручке"
          emptyText="Нет проданных категорий за период"
        />
        <Donut items={platformItems} title="Источник заказов" />
      </div>
      <HorizontalBars
        items={stats.topProducts.map((p, i) => ({
          label: `${p.article ? `[${p.article}] ` : ''}${p.title}`,
          value: p.revenue,
          sub: `${p.quantity} шт`,
          color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]
        }))}
        title="Топ-10 товаров"
        emptyText="Нет проданных товаров"
      />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Orders tab
// ──────────────────────────────────────────────────────────────────────────

function OrdersTab({
  orders,
  loading,
  onNoteSaved
}: {
  orders: Order[]
  loading: boolean
  onNoteSaved: (orderId: string, note: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editingNote, setEditingNote] = useState<{ orderId: string; value: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const saveNote = async () => {
    if (!editingNote) return
    setSaving(true)
    try {
      await api.updateOrderNote(editingNote.orderId, editingNote.value)
      onNoteSaved(editingNote.orderId, editingNote.value)
      setEditingNote(null)
    } catch (e: any) {
      alert('Не удалось сохранить заметку: ' + (e?.message || ''))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="loading">Загрузка заказов...</div>
  if (!orders.length) return <div className="stat-empty">Заказов не найдено</div>

  return (
    <div className="stat-orders-table">
      <table className="promocodes-table">
        <thead>
          <tr>
            <th>Дата</th>
            <th>Номер</th>
            <th>Покупатель</th>
            <th>Платформа</th>
            <th>Сумма</th>
            <th>Статус</th>
            <th>Заметка</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.map(o => {
            const isOpen = expanded.has(o.orderId)
            return (
              <>
                <tr key={o.orderId} className={isOpen ? 'stat-order-row open' : 'stat-order-row'}>
                  <td>{fmtDateTime(o.createdAt)}</td>
                  <td><code>{o.orderId}</code></td>
                  <td>
                    <div>{o.fullName || '—'}</div>
                    <div className="stat-muted">{o.phone}</div>
                  </td>
                  <td>{platformLabel(o.platform)}</td>
                  <td><strong>{fmtMoney(o.total)}</strong></td>
                  <td><span className={`stat-status stat-status-${o.status}`}>{o.status}</span></td>
                  <td className="stat-note-cell">
                    {editingNote?.orderId === o.orderId ? (
                      <div className="stat-note-edit">
                        <input
                          autoFocus
                          value={editingNote.value}
                          onChange={e => setEditingNote({ orderId: o.orderId, value: e.target.value })}
                          onKeyDown={e => { if (e.key === 'Enter') saveNote(); if (e.key === 'Escape') setEditingNote(null) }}
                        />
                        <button className="btn" onClick={saveNote} disabled={saving}>OK</button>
                        <button className="btn btn-cancel" onClick={() => setEditingNote(null)}>×</button>
                      </div>
                    ) : (
                      <div className="stat-note-display" onClick={() => setEditingNote({ orderId: o.orderId, value: o.adminNote })}>
                        {o.adminNote ? o.adminNote : <span className="stat-muted">+ заметка</span>}
                      </div>
                    )}
                  </td>
                  <td>
                    <button className="btn" onClick={() => toggleExpand(o.orderId)}>{isOpen ? '▲' : '▼'}</button>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="stat-order-detail" key={`${o.orderId}-detail`}>
                    <td colSpan={8}>
                      <div className="stat-order-grid">
                        <div>
                          <div className="stat-muted">Адрес</div>
                          <div>{o.country}, {o.city}</div>
                          <div>{o.address}</div>
                          <div className="stat-muted">Доставка</div>
                          <div>{fmtMoney(o.deliveryCost)} ({o.deliveryRegion || '—'})</div>
                        </div>
                        <div>
                          <div className="stat-muted">Контакты</div>
                          <div>{o.fullName}</div>
                          <div>{o.phone}</div>
                          {o.username && <div>TG: {o.username}</div>}
                          {o.customerName && <div>MAX: {o.customerName}</div>}
                          {o.customerChatId && <div className="stat-muted">chat_id: {o.customerChatId}</div>}
                        </div>
                        <div>
                          <div className="stat-muted">Сумма</div>
                          <div>Товары: {fmtMoney(o.itemsTotal)}</div>
                          {o.promocodeCode && <div>Промокод {o.promocodeCode}: −{fmtMoney(o.promocodeDiscount)}</div>}
                          {o.priorityOrder && <div>Приоритет: +{fmtMoney(o.priorityFee)}</div>}
                          <div><strong>Итого: {fmtMoney(o.total)}</strong></div>
                        </div>
                      </div>
                      <div className="stat-order-items">
                        <div className="stat-muted">Позиции</div>
                        {o.items.map((it, i) => (
                          <div className="stat-order-item" key={i}>
                            <span className="stat-order-item-title">{it.article ? `[${it.article}] ` : ''}{it.title}</span>
                            <span className="stat-muted">{it.category}</span>
                            <span>{it.quantity} × {fmtMoney(it.price)}</span>
                            <span><strong>{fmtMoney(it.quantity * it.price)}</strong></span>
                          </div>
                        ))}
                      </div>
                      {o.clientComment && (
                        <div className="stat-order-comment">
                          <div className="stat-muted">Комментарий клиента</div>
                          <div>{o.clientComment}</div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Main page
// ──────────────────────────────────────────────────────────────────────────

export default function StatisticsPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [preset, setPreset] = useState<Preset>('30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [platform, setPlatform] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [hasNote, setHasNote] = useState('')

  const [categoriesList, setCategoriesList] = useState<string[]>([])
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const [orders, setOrders] = useState<Order[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)

  const { fromIso, toIso } = useMemo(() => {
    if (preset === 'all') return { fromIso: '', toIso: '' }
    if (preset === 'custom') return { fromIso: dateToIso(customFrom, false), toIso: dateToIso(customTo, true) }
    const days = Number(preset)
    return { fromIso: isoFromDaysAgo(days - 1), toIso: endOfTodayIso() }
  }, [preset, customFrom, customTo])

  // загрузить список категорий один раз
  useEffect(() => {
    api.getStatsCategories().then(d => setCategoriesList(d.categories || [])).catch(() => {})
  }, [])

  // загрузить stats при изменении фильтров (только для overview)
  useEffect(() => {
    if (tab !== 'overview') return
    setStatsLoading(true)
    api.getStats({ from: fromIso, to: toIso, platform, category })
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setStatsLoading(false))
  }, [tab, fromIso, toIso, platform, category])

  // загрузить orders
  useEffect(() => {
    if (tab !== 'orders') return
    setOrdersLoading(true)
    api.getOrders({ from: fromIso, to: toIso, platform, category, status, search, hasNote })
      .then(d => setOrders(d.orders || []))
      .catch(() => setOrders([]))
      .finally(() => setOrdersLoading(false))
  }, [tab, fromIso, toIso, platform, category, status, search, hasNote])

  const handleLogout = () => { removeToken(); window.location.reload() }

  const onNoteSaved = (orderId: string, note: string) => {
    setOrders(prev => prev.map(o => o.orderId === orderId ? { ...o, adminNote: note } : o))
  }

  return (
    <div className="admin-container">
      <NavBar active="statistics" onNavigate={onNavigate} onLogout={handleLogout} />
      <div className="stat-tabs">
        <button className={`stat-tab${tab === 'overview' ? ' active' : ''}`} onClick={() => setTab('overview')}>Обзор</button>
        <button className={`stat-tab${tab === 'orders' ? ' active' : ''}`} onClick={() => setTab('orders')}>Заказы</button>
      </div>

      <div className="stat-filters">
        <div className="stat-filter-group">
          <label>Период</label>
          <div className="stat-preset-group">
            {(['7','30','90','all','custom'] as Preset[]).map(p => (
              <button key={p} className={`stat-preset${preset === p ? ' active' : ''}`} onClick={() => setPreset(p)}>
                {p === '7' ? '7 дн' : p === '30' ? '30 дн' : p === '90' ? '90 дн' : p === 'all' ? 'Всё' : 'Диапазон'}
              </button>
            ))}
          </div>
        </div>
        {preset === 'custom' && (
          <div className="stat-filter-group">
            <label>Даты</label>
            <div className="stat-custom-dates">
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
              <span>—</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} />
            </div>
          </div>
        )}
        <div className="stat-filter-group">
          <label>Платформа</label>
          <select value={platform} onChange={e => setPlatform(e.target.value)}>
            <option value="">Все</option>
            <option value="telegram">Telegram</option>
            <option value="max">MAX</option>
          </select>
        </div>
        <div className="stat-filter-group">
          <label>Категория</label>
          <select value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">Все</option>
            {categoriesList.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {tab === 'orders' && (
          <>
            <div className="stat-filter-group">
              <label>Статус</label>
              <select value={status} onChange={e => setStatus(e.target.value)}>
                <option value="">Все</option>
                <option value="paid">Оплачен</option>
                <option value="pending">Не оплачен</option>
                <option value="failed">Ошибка оплаты</option>
                <option value="cancelled">Отменён</option>
              </select>
            </div>
            <div className="stat-filter-group stat-filter-grow">
              <label>Поиск</label>
              <input type="text" placeholder="имя, телефон, артикул, номер..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="stat-filter-group">
              <label>Заметка</label>
              <select value={hasNote} onChange={e => setHasNote(e.target.value)}>
                <option value="">Все</option>
                <option value="true">С заметкой</option>
                <option value="false">Без заметки</option>
              </select>
            </div>
          </>
        )}
        {(preset !== '30' || platform || category || status || search || hasNote) && (
          <button className="stat-reset" onClick={() => { setPreset('30'); setPlatform(''); setCategory(''); setStatus(''); setSearch(''); setHasNote(''); setCustomFrom(''); setCustomTo('') }}>Сбросить</button>
        )}
      </div>

      <div className="stat-period-hint">
        {preset === 'all' ? 'За всё время' : preset === 'custom' ? `${customFrom || '—'} → ${customTo || '—'}` : `Последние ${preset} дней`}
        {' · '}
        {tab === 'overview' ? (stats ? `${stats.kpi.ordersCount} заказ(ов)` : '') : `${orders.length} заказ(ов)`}
      </div>

      {tab === 'overview'
        ? <OverviewTab stats={stats} loading={statsLoading} />
        : <OrdersTab orders={orders} loading={ordersLoading} onNoteSaved={onNoteSaved} />}
    </div>
  )
}

export { isoToDate }
