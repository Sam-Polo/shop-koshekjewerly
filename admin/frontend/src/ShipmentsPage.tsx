import { useEffect, useState, useCallback } from 'react'
import { api, removeToken } from './api'
import type { AdminPage } from './BasesPage'

type SummaryItem = { article: string; title: string; pending: number; sent: number; returned: number }
type BySource = Record<string, { pending: number; sent: number }>
type Totals = { pending: number; sent: number; returned: number }
type ShipmentsReport = { summary: SummaryItem[]; bySource: BySource; totals: Totals }

const SOURCE_LABELS: Record<string, string> = { telegram: 'Telegram', tilda: 'Тильда', max: 'Max' }

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function safeDate(iso: string) {
  return new Date(iso + 'T12:00:00')
}

function formatDayLabel(iso: string) {
  const today = todayIso()
  const yesterday = new Date(safeDate(today).getTime() - 86400000).toISOString().slice(0, 10)
  const d = safeDate(iso)
  const dayMonth = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  if (iso === today) return `Сегодня, ${dayMonth}`
  if (iso === yesterday) return `Вчера, ${dayMonth}`
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
}

function shiftIso(iso: string, delta: number) {
  const d = safeDate(iso)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

// SVG arc progress counter
function ArcCounter({ value, total, label, color, track }: {
  value: number; total: number; label: string; color: string; track: string
}) {
  const r = 40
  const circ = 2 * Math.PI * r
  const pct = total > 0 ? Math.min(value / total, 1) : 0
  const offset = circ * (1 - pct)
  return (
    <div className="sh-counter">
      <div className="sh-counter-ring-wrap">
        <svg viewBox="0 0 96 96" className="sh-counter-ring">
          <circle cx="48" cy="48" r={r} fill="none" stroke={track} strokeWidth="5.5" />
          <circle
            cx="48" cy="48" r={r}
            fill="none"
            stroke={color}
            strokeWidth="5.5"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 48 48)"
            style={{ transition: 'stroke-dashoffset 0.9s cubic-bezier(0.4,0,0.2,1)' }}
          />
        </svg>
        <div className="sh-counter-inner">
          <span className="sh-counter-num">{value}</span>
          <span className="sh-counter-pct" style={{ color }}>{total > 0 ? `${Math.round(pct * 100)}%` : ''}</span>
        </div>
      </div>
      <div className="sh-counter-label">{label}</div>
    </div>
  )
}

export default function ShipmentsPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const [selectedIso, setSelectedIso] = useState(todayIso)
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set())
  const [report, setReport] = useState<ShipmentsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const srcList = activeSources.size > 0 ? [...activeSources] : [null as null]

      const results = await Promise.all(
        srcList.map(src =>
          api.getShipments({ from: selectedIso, to: selectedIso, ...(src ? { source: src } : {}) })
        )
      )

      if (srcList.length === 1) {
        setReport(results[0])
        return
      }

      // merge multi-source results
      const articleMap = new Map<string, SummaryItem>()
      const totals: Totals = { pending: 0, sent: 0, returned: 0 }
      const bySource: BySource = {}
      for (const r of results) {
        for (const item of r.summary) {
          const ex = articleMap.get(item.article)
          if (ex) { ex.pending += item.pending; ex.sent += item.sent; ex.returned += item.returned }
          else articleMap.set(item.article, { ...item })
        }
        totals.pending += r.totals.pending
        totals.sent += r.totals.sent
        totals.returned += r.totals.returned
        Object.assign(bySource, r.bySource)
      }
      setReport({
        summary: [...articleMap.values()].sort((a, b) => b.pending - a.pending),
        totals,
        bySource,
      })
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [selectedIso, activeSources])

  useEffect(() => { void load() }, [load])

  const navigate = (delta: number) => {
    const next = shiftIso(selectedIso, delta)
    if (next <= todayIso()) setSelectedIso(next)
  }

  const toggleSource = (src: string) => {
    setActiveSources(prev => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src); else next.add(src)
      return next
    })
  }

  const totals = report?.totals ?? { pending: 0, sent: 0, returned: 0 }
  const totalAll = totals.pending + totals.sent + totals.returned
  const bySource = report?.bySource ?? {}
  const summary = report?.summary ?? []
  const hasReturned = summary.some(s => s.returned > 0)
  const dayLabel = formatDayLabel(selectedIso)
  const isToday = selectedIso === todayIso()

  const visibleSources = Object.entries(bySource).filter(([, c]) => c.pending + c.sent > 0)

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1>KOSHEK JEWERLY</h1>
        <div className="header-nav">
          <button className="nav-btn" onClick={() => onNavigate?.('products')}>Товары</button>
          <button className="nav-btn" onClick={() => onNavigate?.('promocodes')}>Промокоды</button>
          <button className="nav-btn" onClick={() => onNavigate?.('categories')}>Категории</button>
          <button className="nav-btn" onClick={() => onNavigate?.('bases')}>Конструктор</button>
          <button className="nav-btn" onClick={() => onNavigate?.('statistics')}>Статистика</button>
          <button className="nav-btn active" onClick={() => onNavigate?.('shipments')}>Учёт</button>
          <button className="nav-btn" onClick={() => onNavigate?.('customers')}>Клиенты</button>
          <button className="nav-btn" onClick={() => onNavigate?.('settings')}>Настройки</button>
        </div>
        <button onClick={() => { removeToken(); window.location.reload() }} className="logout-btn">Выйти</button>
      </header>

      <div className="sh-page">
        {loading && <div className="sh-progress-bar" />}

        {/* Day navigation */}
        <div className="sh-day-nav">
          <button className="sh-nav-arrow" onClick={() => navigate(-1)} aria-label="Предыдущий день">‹</button>

          <label className="sh-day-label-wrap" title="Выбрать дату">
            <span className="sh-day-text">{dayLabel}</span>
            <input
              type="date"
              className="sh-date-pick"
              value={selectedIso}
              max={todayIso()}
              onChange={e => { if (e.target.value && e.target.value <= todayIso()) setSelectedIso(e.target.value) }}
            />
          </label>

          <button
            className="sh-nav-arrow"
            onClick={() => navigate(1)}
            disabled={isToday}
            aria-label="Следующий день"
          >›</button>

          <button className="sh-refresh-btn" onClick={load} disabled={loading} title="Обновить">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round"
              className={loading ? 'spinning' : ''}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>

        {error && <div className="sh-error">{error}</div>}

        {/* Circular counters */}
        <div className="sh-counters">
          <ArcCounter value={totals.pending} total={totalAll} label="Новых"
            color="#f472b6" track="rgba(244,114,182,0.13)" />
          <ArcCounter value={totals.sent} total={totalAll} label="Отправлено"
            color="#a78bfa" track="rgba(167,139,250,0.13)" />
          <ArcCounter value={totals.returned} total={totalAll} label="Возвращено"
            color="#6ee7b7" track="rgba(110,231,183,0.13)" />
        </div>

        {/* Source chips */}
        {visibleSources.length > 1 && (
          <div className="sh-chips">
            {visibleSources.map(([src, counts]) => (
              <button
                key={src}
                className={`sh-chip ${activeSources.has(src) ? 'sh-chip--on' : ''}`}
                onClick={() => toggleSource(src)}
              >
                {SOURCE_LABELS[src] ?? src}
                <span className="sh-chip-num">{counts.pending + counts.sent}</span>
              </button>
            ))}
          </div>
        )}

        {/* Items table */}
        {report && summary.length === 0 && (
          <div className="sh-empty">Нет заказов за этот день</div>
        )}

        {summary.length > 0 && (
          <div className="sh-card">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Артикул</th>
                  <th>Название</th>
                  <th className="sh-th-p">Новых</th>
                  <th className="sh-th-s">Отправлено</th>
                  {hasReturned && <th className="sh-th-r">Возвращено</th>}
                </tr>
              </thead>
              <tbody>
                {summary.map(item => (
                  <tr key={item.article} className={item.pending > 0 ? 'sh-row-hot' : ''}>
                    <td><span className="sh-art">{item.article}</span></td>
                    <td className="sh-name">{item.title || <span className="sh-muted">—</span>}</td>
                    <td className="sh-td-p">
                      {item.pending > 0 ? <strong>{item.pending}</strong> : <span className="sh-muted">—</span>}
                    </td>
                    <td className="sh-td-s">
                      {item.sent > 0 ? item.sent : <span className="sh-muted">—</span>}
                    </td>
                    {hasReturned && (
                      <td className="sh-td-r">
                        {item.returned > 0 ? item.returned : <span className="sh-muted">—</span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
