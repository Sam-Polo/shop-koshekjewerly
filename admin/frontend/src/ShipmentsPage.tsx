import { useEffect, useState, useCallback, useRef } from 'react'
import { api, removeToken } from './api'
import type { AdminPage } from './BasesPage'

type SummaryItem = { article: string; title: string; pending: number; in_work: number; assembled: number; sent: number; returned: number }
type BySource = Record<string, { pending: number; in_work: number; assembled: number; sent: number }>
type Totals = { pending: number; in_work: number; assembled: number; sent: number; returned: number }
type ShipmentsReport = { summary: SummaryItem[]; bySource: BySource; totals: Totals }

const SOURCE_LABELS: Record<string, string> = { telegram: 'Telegram', tilda: 'Тильда', max: 'Max' }
const ALL_SOURCES = ['telegram', 'tilda', 'max'] as const
const PERIODS = [
  { label: 'Сегодня', days: 1 },
  { label: '3 дня',   days: 3 },
  { label: '7 дней',  days: 7 },
  { label: '30 дней', days: 30 },
] as const

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function safeDate(iso: string) {
  return new Date(iso + 'T12:00:00')
}

function shiftIso(iso: string, delta: number) {
  const d = safeDate(iso)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

function formatDayLabel(iso: string) {
  const today = todayIso()
  const yesterday = shiftIso(today, -1)
  const d = safeDate(iso)
  const dayMonth = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
  if (iso === today)     return `Сегодня, ${dayMonth}`
  if (iso === yesterday) return `Вчера, ${dayMonth}`
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' })
}

function formatRangeLabel(from: string, to: string) {
  if (from === to) return formatDayLabel(from)
  const fmt = (iso: string) => safeDate(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  return `${fmt(from)} — ${fmt(to)}`
}

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
            fill="none" stroke={color} strokeWidth="5.5"
            strokeDasharray={circ} strokeDashoffset={offset}
            strokeLinecap="round" transform="rotate(-90 48 48)"
            style={{ transition: 'stroke-dashoffset 0.9s cubic-bezier(0.4,0,0.2,1)' }}
          />
        </svg>
        <div className="sh-counter-inner">
          <span className="sh-counter-num">{value}</span>
          {total > 0 && <span className="sh-counter-pct" style={{ color }}>{Math.round(pct * 100)}%</span>}
        </div>
      </div>
      <div className="sh-counter-label">{label}</div>
    </div>
  )
}

export default function ShipmentsPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const [dateFrom, setDateFrom] = useState(todayIso)
  const [dateTo,   setDateTo]   = useState(todayIso)
  const [activePeriod, setActivePeriod] = useState<number | null>(1)   // 1 = "Сегодня"
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set())
  const [report,  setReport]  = useState<ShipmentsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const responseCache = useRef<Map<string, ShipmentsReport>>(new Map())
  const dateInputRef    = useRef<HTMLInputElement>(null)
  const dateFromRef     = useRef<HTMLInputElement>(null)
  const dateToRef       = useRef<HTMLInputElement>(null)

  const setPeriod = useCallback((days: number) => {
    const today = todayIso()
    setDateFrom(days === 1 ? today : shiftIso(today, -(days - 1)))
    setDateTo(today)
    setActivePeriod(days)
  }, [])

  const navigateDay = (delta: number) => {
    if (dateFrom !== dateTo) return
    const next = shiftIso(dateFrom, delta)
    if (next <= todayIso()) {
      setDateFrom(next)
      setDateTo(next)
      setActivePeriod(null)
    }
  }

  const openDatePicker = () => {
    const el = dateInputRef.current
    if (!el) return
    if (typeof (el as any).showPicker === 'function') (el as any).showPicker()
    else el.click()
  }

  const load = useCallback(async (nocache = false) => {
    const cacheKey = `${dateFrom}|${dateTo}|${[...activeSources].sort().join(',')}`

    if (!nocache) {
      const cached = responseCache.current.get(cacheKey)
      if (cached) {
        setReport(cached)
        setError('')
        return
      }
    } else {
      responseCache.current.delete(cacheKey)
    }

    setLoading(true)
    setError('')
    try {
      const srcList = activeSources.size > 0 ? [...activeSources] : [null as null]

      const results = await Promise.all(
        srcList.map(src =>
          api.getShipments({
            from: dateFrom,
            to: dateTo,
            ...(src ? { source: src } : {}),
            ...(nocache ? { nocache: true } : {}),
          })
        )
      )

      let merged: ShipmentsReport
      if (srcList.length === 1) {
        merged = results[0]
      } else {
        const articleMap = new Map<string, SummaryItem>()
        const totals: Totals = { pending: 0, in_work: 0, assembled: 0, sent: 0, returned: 0 }
        const bySource: BySource = {}
        for (const r of results) {
          for (const item of r.summary) {
            const ex = articleMap.get(item.article)
            if (ex) {
              ex.pending   += item.pending
              ex.in_work   += item.in_work
              ex.assembled += item.assembled
              ex.sent      += item.sent
              ex.returned  += item.returned
            } else articleMap.set(item.article, { ...item })
          }
          totals.pending   += r.totals.pending
          totals.in_work   += r.totals.in_work
          totals.assembled += r.totals.assembled
          totals.sent      += r.totals.sent
          totals.returned  += r.totals.returned
          Object.assign(bySource, r.bySource)
        }
        merged = {
          summary: [...articleMap.values()].sort((a, b) => b.pending - a.pending),
          totals,
          bySource,
        }
      }

      responseCache.current.set(cacheKey, merged)
      setReport(merged)
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [dateFrom, dateTo, activeSources])

  useEffect(() => { void load() }, [load])

  const toggleSource = (src: string) => {
    setActiveSources(prev => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src); else next.add(src)
      return next
    })
  }

  const totals = report?.totals ?? { pending: 0, in_work: 0, assembled: 0, sent: 0, returned: 0 }
  const totalAll = totals.pending + totals.in_work + totals.assembled + totals.sent + totals.returned
  const bySource = report?.bySource ?? {}
  const summary  = report?.summary ?? []
  const hasInWork    = summary.some(s => s.in_work > 0)
  const hasAssembled = summary.some(s => s.assembled > 0)
  const hasReturned  = summary.some(s => s.returned > 0)
  const isRangeMode  = dateFrom !== dateTo
  const isTodayDay   = !isRangeMode && dateFrom === todayIso()

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
          <button
            className="sh-nav-arrow"
            onClick={() => navigateDay(-1)}
            disabled={isRangeMode}
            aria-label="Предыдущий день"
          >‹</button>

          <div className="sh-day-label-wrap" onClick={openDatePicker} title="Выбрать дату">
            <span className="sh-day-text">{formatRangeLabel(dateFrom, dateTo)}</span>
            <input
              ref={dateInputRef}
              type="date"
              className="sh-date-pick"
              value={dateFrom}
              max={todayIso()}
              onChange={e => {
                const v = e.target.value
                if (v && v <= todayIso()) {
                  setDateFrom(v)
                  setDateTo(v)
                  setActivePeriod(null)
                }
              }}
            />
          </div>

          <button
            className="sh-nav-arrow"
            onClick={() => navigateDay(1)}
            disabled={isRangeMode || isTodayDay}
            aria-label="Следующий день"
          >›</button>

          <button className="sh-refresh-btn" onClick={() => load(true)} disabled={loading} title="Обновить">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round"
              className={loading ? 'spinning' : ''}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        </div>

        {/* Period presets */}
        <div className="sh-period-chips">
          {PERIODS.map(p => (
            <button
              key={p.days}
              className={`sh-pchip ${activePeriod === p.days ? 'sh-pchip--on' : ''}`}
              onClick={() => setPeriod(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Custom date range */}
        <div className="sh-custom-range">
          <span className="sh-custom-range-label">С</span>
          <input
            ref={dateFromRef}
            type="date"
            className="sh-custom-date"
            value={dateFrom}
            max={dateTo}
            onChange={e => {
              if (e.target.value) { setDateFrom(e.target.value); setActivePeriod(null) }
            }}
          />
          <span className="sh-custom-sep">—</span>
          <input
            ref={dateToRef}
            type="date"
            className="sh-custom-date"
            value={dateTo}
            min={dateFrom}
            max={todayIso()}
            onChange={e => {
              if (e.target.value) { setDateTo(e.target.value); setActivePeriod(null) }
            }}
          />
        </div>

        {error && <div className="sh-error">{error}</div>}

        {/* Skeleton — first load */}
        {loading && !report && (
          <>
            <div className="sh-counters">
              {[0,1,2,3,4].map(i => (
                <div key={i} className="sh-counter">
                  <div className="sh-skeleton-ring" />
                  <div className="sh-skeleton-label" />
                </div>
              ))}
            </div>
            <div className="sh-card">
              <table className="sh-table"><tbody>
                {[0,1,2,3,4].map(i => (
                  <tr key={i}><td colSpan={6}><div className="sh-skeleton-row" style={{ width: `${70 + i * 5}%` }} /></td></tr>
                ))}
              </tbody></table>
            </div>
          </>
        )}

        {/* Content — dim while refreshing */}
        {report && (
          <div className={loading ? 'sh-content sh-content--loading' : 'sh-content'}>
            <div className="sh-counters">
              <ArcCounter value={totals.pending}   total={totalAll} label="К отправке"  color="#db2777" track="rgba(244,114,182,0.22)" />
              <ArcCounter value={totals.in_work}   total={totalAll} label="В работе"    color="#ea580c" track="rgba(251,146,60,0.22)"  />
              <ArcCounter value={totals.assembled} total={totalAll} label="Собран"      color="#0284c7" track="rgba(56,189,248,0.22)"  />
              <ArcCounter value={totals.sent}      total={totalAll} label="Отправлено"  color="#7c3aed" track="rgba(139,92,246,0.2)"   />
              <ArcCounter value={totals.returned}  total={totalAll} label="Возвращено"  color="#059669" track="rgba(16,185,129,0.2)"   />
            </div>

            {/* Source chips */}
            <div className="sh-chips">
              {ALL_SOURCES.map(src => {
                const c = bySource[src]
                const n = (c?.pending ?? 0) + (c?.in_work ?? 0) + (c?.assembled ?? 0) + (c?.sent ?? 0)
                return (
                  <button
                    key={src}
                    className={`sh-chip ${activeSources.has(src) ? 'sh-chip--on' : ''}`}
                    onClick={() => toggleSource(src)}
                  >
                    {SOURCE_LABELS[src]}
                    <span className="sh-chip-num">{n}</span>
                  </button>
                )
              })}
            </div>

            {summary.length === 0 && <div className="sh-empty">Нет заказов за этот период</div>}
            {summary.length > 0 && (
              <div className="sh-card">
                <table className="sh-table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Название</th>
                      <th className="sh-th-p">К отправке</th>
                      {hasInWork    && <th className="sh-th-w">В работе</th>}
                      {hasAssembled && <th className="sh-th-a">Собран</th>}
                      <th className="sh-th-s">Отправлено</th>
                      {hasReturned  && <th className="sh-th-r">Возвращено</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map(item => (
                      <tr key={item.article} className={item.pending + item.in_work + item.assembled > 0 ? 'sh-row-hot' : ''}>
                        <td><span className="sh-art">{item.article}</span></td>
                        <td className="sh-name">{item.title || <span className="sh-muted">—</span>}</td>
                        <td className="sh-td-p">
                          {item.pending > 0 ? <strong>{item.pending}</strong> : <span className="sh-muted">—</span>}
                        </td>
                        {hasInWork && (
                          <td className="sh-td-w">{item.in_work > 0 ? item.in_work : <span className="sh-muted">—</span>}</td>
                        )}
                        {hasAssembled && (
                          <td className="sh-td-a">{item.assembled > 0 ? item.assembled : <span className="sh-muted">—</span>}</td>
                        )}
                        <td className="sh-td-s">{item.sent > 0 ? item.sent : <span className="sh-muted">—</span>}</td>
                        {hasReturned && (
                          <td className="sh-td-r">{item.returned > 0 ? item.returned : <span className="sh-muted">—</span>}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
