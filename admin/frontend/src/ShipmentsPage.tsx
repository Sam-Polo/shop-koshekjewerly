import { useEffect, useState } from 'react'
import { api, removeToken } from './api'
import type { AdminPage } from './BasesPage'
import './App.css'

type SummaryItem = {
  article: string
  title: string
  pending: number
  sent: number
  returned: number
}

type BySource = Record<string, { pending: number; sent: number }>

type Totals = { pending: number; sent: number; returned: number }

type ShipmentsReport = {
  summary: SummaryItem[]
  bySource: BySource
  totals: Totals
}

type Preset = '7' | '30' | '90' | 'all' | 'custom'
type SourceFilter = 'all' | 'telegram' | 'tilda' | 'max'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgoIso(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

const SOURCE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  tilda: 'Тильда',
  max: 'Max',
}

export default function ShipmentsPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const [report, setReport] = useState<ShipmentsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [preset, setPreset] = useState<Preset>('30')
  const [from, setFrom] = useState(daysAgoIso(30))
  const [to, setTo] = useState(todayIso())
  const [source, setSource] = useState<SourceFilter>('all')

  const handleLogout = () => { removeToken(); window.location.reload() }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const params: Record<string, string> = {}
      if (preset !== 'all') { params.from = from; params.to = to }
      if (source !== 'all') params.source = source
      const data = await api.getShipments(params)
      setReport(data)
    } catch (e: any) {
      setError(e.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const applyPreset = (p: Preset) => {
    setPreset(p)
    const today = todayIso()
    if (p === '7') { setFrom(daysAgoIso(7)); setTo(today) }
    else if (p === '30') { setFrom(daysAgoIso(30)); setTo(today) }
    else if (p === '90') { setFrom(daysAgoIso(90)); setTo(today) }
    else if (p === 'all') { setFrom(''); setTo('') }
    // 'custom' — user edits from/to manually
  }

  const totals = report?.totals
  const summary = report?.summary ?? []
  const bySource = report?.bySource ?? {}

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1>Админ-панель — KOSHEK JEWERLY</h1>
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
        <button onClick={handleLogout} className="logout-btn">Выйти</button>
      </header>

      <div className="admin-content">
        <h2 style={{ marginBottom: '1rem' }}>Учёт отправок</h2>

        {/* Фильтры */}
        <div className="toolbar" style={{ flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {(['7', '30', '90', 'all', 'custom'] as Preset[]).map(p => (
              <button
                key={p}
                className={`btn-tab ${preset === p ? 'active' : ''}`}
                onClick={() => applyPreset(p)}
              >
                {p === '7' ? '7 дней' : p === '30' ? '30 дней' : p === '90' ? '90 дней' : p === 'all' ? 'Всё время' : 'Диапазон'}
              </button>
            ))}
          </div>

          {(preset === 'custom' || preset === 'all') && preset !== 'all' && (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
              <span>—</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} />
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label style={{ fontWeight: 500 }}>Источник:</label>
            <select value={source} onChange={e => setSource(e.target.value as SourceFilter)}>
              <option value="all">Все</option>
              <option value="telegram">Telegram</option>
              <option value="tilda">Тильда</option>
              <option value="max">Max</option>
            </select>
          </div>

          <button className="btn-refresh" onClick={load} disabled={loading} title="Обновить">
            <span className={`refresh-icon ${loading ? 'spinning' : ''}`}>↻</span>
          </button>
        </div>

        {error && <div className="error-message">{error}</div>}

        {loading && !report && <div className="loading">Загрузка…</div>}

        {report && (
          <>
            {/* KPI */}
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
              <KpiCard label="К отправке" value={totals?.pending ?? 0} accent="#bf9243" />
              <KpiCard label="Отправлено" value={totals?.sent ?? 0} accent="#5e6623" />
              {(totals?.returned ?? 0) > 0 && (
                <KpiCard label="Возвращено" value={totals?.returned ?? 0} accent="#999" />
              )}
            </div>

            {/* По источникам */}
            {Object.keys(bySource).length > 1 && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h3 style={{ marginBottom: '0.5rem', fontSize: '1rem' }}>По источникам</h3>
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  {Object.entries(bySource).map(([src, counts]) => (
                    <div key={src} style={{ background: '#f8f5ee', padding: '0.6rem 1rem', borderRadius: '8px', minWidth: '140px' }}>
                      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{SOURCE_LABELS[src] ?? src}</div>
                      <div style={{ fontSize: '0.88rem', color: '#bf9243' }}>К отправке: {counts.pending}</div>
                      <div style={{ fontSize: '0.88rem', color: '#5e6623' }}>Отправлено: {counts.sent}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Таблица по артикулам */}
            {summary.length === 0 ? (
              <div className="empty-state">Нет данных за выбранный период</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="shipments-table">
                  <thead>
                    <tr>
                      <th>Артикул</th>
                      <th>Название</th>
                      <th style={{ textAlign: 'center', color: '#bf9243' }}>К отправке</th>
                      <th style={{ textAlign: 'center', color: '#5e6623' }}>Отправлено</th>
                      {summary.some(s => s.returned > 0) && (
                        <th style={{ textAlign: 'center', color: '#999' }}>Возвращено</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {summary.map(item => (
                      <tr key={item.article} className={item.pending > 0 ? 'row-pending' : ''}>
                        <td><code>{item.article}</code></td>
                        <td>{item.title || <span style={{ color: '#aaa' }}>—</span>}</td>
                        <td style={{ textAlign: 'center', fontWeight: item.pending > 0 ? 700 : 400 }}>
                          {item.pending > 0 ? item.pending : '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>{item.sent > 0 ? item.sent : '—'}</td>
                        {summary.some(s => s.returned > 0) && (
                          <td style={{ textAlign: 'center', color: '#999' }}>{item.returned > 0 ? item.returned : '—'}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function KpiCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{
      background: '#f8f5ee',
      border: `2px solid ${accent}`,
      borderRadius: '10px',
      padding: '0.75rem 1.25rem',
      minWidth: '130px',
    }}>
      <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ fontSize: '2rem', fontWeight: 700, color: accent }}>{value}</div>
    </div>
  )
}
