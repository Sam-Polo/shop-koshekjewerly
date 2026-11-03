import { useCallback, useEffect, useState } from 'react'
import { api, removeToken } from './api'
import type { AdminPage } from './BasesPage'
import './App.css'

// Раздел EMS: международные заказы Почты России. Трек покупатель получает только после
// того, как менеджер назначит здесь дату отправки (см. docs/integrations/pochta-ems.md).

type EmsStage =
  | 'no_pochta_order' | 'awaiting_date' | 'not_paid' | 'ready' | 'overdue'
  | 'accepted' | 'in_transit' | 'archived'

type PochtaState = {
  orderId?: number
  batch?: string
  shpi?: string
  date?: string
  checkinAt?: string
  f103?: string
  forms?: string
  docsDate?: string
  releasedAt?: string
  error?: string
}

type EmsOrder = {
  orderId: string
  paidAt: string
  platform: string
  customerChatId: string
  customerName: string
  fullName: string
  phone: string
  username: string
  country: string
  city: string
  address: string
  deliveryCost: number
  total: number
  clientComment: string
  adminNote: string
  shpi: string
  items: { title: string; price: number; quantity: number; option?: string }[]
  state: PochtaState
  live: { batchStatus: string | null; operationName: string | null; lastOperDate: string | null } | null
  liveError?: string
  stage: EmsStage
  shipping: boolean
}

type ActionResult = { tone: 'ok' | 'warn' | 'bad'; text: string; details?: string[] }

const OFFICE = '121596, ул. Барвихинская, 8'

function fmtMoney(n: number): string {
  return Math.round(n).toLocaleString('ru-RU') + ' ₽'
}

function fmtDateTime(s: string): string {
  const d = new Date(s)
  if (!s || !Number.isFinite(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** '2026-11-05' → '05.11' */
function fmtDay(iso?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '')
  return m ? `${m[3]}.${m[2]}` : '—'
}

function errorText(code?: string): string {
  if (!code) return ''
  if (code === 'NOT_ENOUGH_FUNDS') return 'Не хватает денег на балансе Почты — пополните онлайн-баланс в ЛК otpravka.pochta.ru и нажмите «Повторить».'
  if (code === 'PAST_DUE_DATE') return 'Дата сдачи прошла — выберите новую.'
  return `Ошибка Почты: ${code}`
}

type StageView = { tone: 'ok' | 'warn' | 'bad' | 'done' | 'muted'; label: string; detail?: string }

function stageView(o: EmsOrder): StageView {
  const s = o.state
  switch (o.stage) {
    case 'no_pochta_order':
      return {
        tone: 'bad', label: 'Заказа нет в Почте',
        detail: s.error ? `Почта не приняла заказ: ${s.error}` : 'Не создался при оплате. Назначьте дату — заказ создастся заново.',
      }
    case 'awaiting_date':
      return { tone: 'warn', label: 'Ждёт даты отправки', detail: 'Трека у покупателя пока нет.' }
    case 'not_paid':
      return {
        tone: 'bad', label: 'Партия создана, но не оплачена',
        detail: errorText(s.error) || 'Нажмите «Повторить» — оформление продолжится с того же места.',
      }
    case 'ready':
      return {
        tone: 'ok', label: `К отправке ${fmtDay(s.date)}`,
        detail: s.f103 && s.forms
          ? `Распечатайте документы и несите в отделение ${OFFICE}.`
          : 'Не все документы скачались — нажмите «Повторить».',
      }
    case 'overdue':
      return { tone: 'bad', label: `Дата ${fmtDay(s.date)} прошла — посылку не сдали`, detail: 'Выберите новую дату и перепечатайте документы.' }
    case 'accepted':
      return { tone: 'done', label: 'Принято почтой', detail: 'Можно отбить покупателю «отправлен».' }
    case 'in_transit':
      return { tone: 'done', label: 'В пути', detail: o.live?.operationName ?? undefined }
    case 'archived':
      return { tone: 'muted', label: 'В архиве Почты' }
  }
}

function Cheatsheet() {
  return (
    <details className="ems-cheatsheet" open>
      <summary>Шпаргалка: как отправлять EMS</summary>
      <ol>
        <li>После оплаты у покупателя есть только подтверждение заказа. <b>Трек он получит, когда вы назначите дату отправки.</b></li>
        <li>Дату ставьте, когда точно знаете день похода на почту: она печатается в документах, и отделение ждёт посылку именно в этот день. В этот момент с онлайн-баланса Почты списывается доставка.</li>
        <li>Распечатайте ф.103 и бланки (ссылки появятся в карточке заказа) и несите посылку с ними в отделение <b>{OFFICE}</b>. Только туда — документы уходят в это отделение.</li>
        <li>Посылка — не тяжелее 200 г: по этому весу считалась доставка.</li>
        <li>Не успели в этот день — выберите новую дату, нажмите «Перенести дату» и перепечатайте документы.</li>
        <li>«Не хватает денег на балансе» — пополните онлайн-баланс в ЛК otpravka.pochta.ru и нажмите кнопку ещё раз.</li>
        <li>Когда почта примет посылку, нажмите «Отбить» — покупатель получит «Ваш заказ отправлен».</li>
      </ol>
    </details>
  )
}

function EmsCard({ o, today, onChanged }: { o: EmsOrder; today: string; onChanged: () => void }) {
  const s = o.state
  const view = stageView(o)
  const canSetDate = ['no_pochta_order', 'awaiting_date', 'not_paid', 'ready', 'overdue'].includes(o.stage)
  const initialDate = s.date && s.date >= today ? s.date : today
  const [date, setDate] = useState(initialDate)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [notifying, setNotifying] = useState(false)
  const notified = o.adminNote.includes('shipped_notified')
  const trackUrl = o.shpi ? `https://www.pochta.ru/tracking#${o.shpi}` : ''

  useEffect(() => { setDate(initialDate) }, [initialDate])

  const docsMissing = !s.f103 || !s.forms
  let buttonLabel = 'Назначить дату'
  let buttonDisabled = false
  if (o.stage === 'not_paid') buttonLabel = 'Повторить'
  if (o.stage === 'ready' || o.stage === 'overdue') {
    if (date !== s.date) buttonLabel = 'Перенести дату'
    else if (docsMissing) buttonLabel = 'Повторить'
    else { buttonLabel = 'Дата назначена'; buttonDisabled = true }
  }

  const ship = async () => {
    const charging = !s.checkinAt
    const question = charging
      ? `Назначить отправку ${fmtDay(date)}?\n\nС баланса Почты спишется доставка, покупатель получит трек, отделение ${OFFICE} будет ждать посылку в этот день.`
      : `Перенести отправку на ${fmtDay(date)}?\n\nДокументы с прежней датой станут недействительны — распечатайте новые.`
    if (o.stage !== 'not_paid' && !confirm(question)) return
    setBusy(true)
    setResult(null)
    try {
      const r = await api.shipEms(o.orderId, date)
      if (r.pending) setResult({ tone: 'warn', text: r.message || 'Почта отвечает долго — обновите список через минуту.' })
      else if (r.ok) setResult({ tone: r.warnings?.length ? 'warn' : 'ok', text: 'Готово: документы и трек ниже.', details: r.warnings })
      else setResult({ tone: 'bad', text: r.message || r.error || 'Не получилось' })
      onChanged()
    } catch (e: any) {
      const msg = String(e?.message || '')
      setResult({
        tone: 'bad',
        text: msg === 'admin_key_mismatch'
          ? 'ADMIN_IMPORT_KEY админки не совпадает с основным бэкендом (Render) — проверьте env.'
          : `Ошибка: ${msg}`,
      })
    } finally {
      setBusy(false)
    }
  }

  const notifyShipped = async () => {
    const q = notified
      ? 'Покупателю уже отправляли «заказ отправлен». Отправить ещё раз?'
      : 'Покупатель получит «Ваш заказ отправлен» с трек-ссылкой. Отправить?'
    if (!confirm(q)) return
    setNotifying(true)
    try {
      // флаг shipped_notified в заметку заказа пишет сам бэкенд
      await api.notifyShipped(o.orderId)
      setResult({ tone: 'ok', text: 'Покупателю отправлено «заказ отправлен».' })
      onChanged()
    } catch (e: any) {
      const msg = String(e?.message || '')
      setResult({
        tone: 'bad',
        text: msg === 'no_chat_id' ? 'У покупателя нет chat_id — уведомить невозможно.'
          : msg === 'no_track' ? 'Трека ещё нет — сначала назначьте дату отправки.'
          : msg === 'send_failed' ? 'Telegram не доставил сообщение (алерт в канале ошибок).'
          : `Ошибка: ${msg}`,
      })
    } finally {
      setNotifying(false)
    }
  }

  return (
    <div className={`ems-card ems-card--${view.tone}`}>
      <div className="ems-card-main">
        <div className="ems-card-title">
          <code>{o.orderId}</code>
          <span className="stat-muted">оплачен {fmtDateTime(o.paidAt)}</span>
          {o.platform === 'max' && <span className="ems-chip">MAX</span>}
        </div>
        <div className="ems-customer">
          <b>{o.fullName || '—'}</b>
          {o.phone && <span> · {o.phone}</span>}
          {o.username && <span> · {o.username}</span>}
          {!o.customerChatId && <span className="ems-warn-inline"> · нет chat_id — трек передать вручную</span>}
        </div>
        <div className="ems-address">{o.country}{o.address ? `, ${o.address}` : ''}</div>
        <ul className="ems-items">
          {o.items.map((it, i) => (
            <li key={i}>{it.title}{it.option ? ` (${it.option})` : ''} × {it.quantity}</li>
          ))}
        </ul>
        <div className="stat-muted">Итого {fmtMoney(o.total)}, из них доставка {fmtMoney(o.deliveryCost)}</div>
        {o.clientComment && <div className="stat-muted ems-comment">💬 {o.clientComment}</div>}
      </div>

      <div className="ems-card-side">
        <div className={`ems-stage ems-stage--${view.tone}`}>{o.shipping ? 'Оформляется…' : view.label}</div>
        {view.detail && <div className="ems-stage-detail">{view.detail}</div>}
        {o.liveError && <div className="ems-warn-inline">Почта не ответила — статус может быть неточным.</div>}

        {(o.shpi || s.f103 || s.forms) && (
          <div className="ems-links">
            {o.shpi && <div>ШПИ: <a href={trackUrl} target="_blank" rel="noreferrer"><code>{o.shpi}</code></a></div>}
            {s.f103 && <div>📄 <a href={s.f103} target="_blank" rel="noreferrer">Ф.103 на {fmtDay(s.docsDate ?? s.date)}</a></div>}
            {s.forms && <div>🏷 <a href={s.forms} target="_blank" rel="noreferrer">Бланки</a></div>}
          </div>
        )}

        {canSetDate && (
          <div className="ems-date-row">
            <input
              type="date"
              value={date}
              min={today}
              onChange={e => setDate(e.target.value)}
              disabled={busy || o.shipping}
            />
            <button
              className="btn ems-btn-primary"
              onClick={ship}
              disabled={busy || o.shipping || buttonDisabled || !date || date < today}
            >
              {busy ? 'Почта отвечает…' : buttonLabel}
            </button>
          </div>
        )}

        {o.shpi && (
          <button
            className={`btn ems-btn-ghost${o.stage === 'accepted' && !notified ? ' ems-btn-attention' : ''}`}
            onClick={notifyShipped}
            disabled={notifying}
          >
            {notifying ? '…' : notified ? '✓ Отбито' : 'Отбить «отправлен»'}
          </button>
        )}

        {result && (
          <div className={`ems-result ems-result--${result.tone}`}>
            {result.text}
            {result.details && result.details.length > 0 && (
              <ul>{result.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Заказ вне мини-аппа ─────────────────────────────────────────────────────────

const LATIN_RE = /^[A-Za-z0-9\s.,'\-/()#&]+$/

type ItemDraft = { article: string; quantity: string; option: string }

function ManualOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (orderId: string) => void }) {
  const [countries, setCountries] = useState<Array<{ code: number; name: string }>>([])
  const [platform, setPlatform] = useState<'telegram' | 'max'>('telegram')
  const [chatId, setChatId] = useState('')
  const [username, setUsername] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [countryCode, setCountryCode] = useState('')
  const [region, setRegion] = useState('')
  const [city, setCity] = useState('')
  const [street, setStreet] = useState('')
  const [index, setIndex] = useState('')
  const [items, setItems] = useState<ItemDraft[]>([{ article: '', quantity: '1', option: '' }])
  const [deliveryCost, setDeliveryCost] = useState('')
  const [comments, setComments] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getEmsCountries().then(d => setCountries(d.countries || [])).catch(() => setCountries([]))
  }, [])

  const latin = (v: string) => !v.trim() || LATIN_RE.test(v.trim())

  const validate = (): string => {
    if (chatId && !/^\d{3,20}$/.test(chatId.trim())) return 'chat_id — только цифры'
    if (!fullName.trim() || !latin(fullName)) return 'ФИО — латиницей, как в загранпаспорте'
    if (phone.replace(/\D/g, '').length < 7) return 'Телефон — с кодом страны'
    if (!countryCode) return 'Выберите страну'
    if (!latin(region)) return 'Регион — латиницей'
    if (!city.trim() || !latin(city)) return 'Город — латиницей'
    if (!street.trim() || !latin(street)) return 'Улица, дом, квартира — латиницей'
    if (!index.trim()) return 'Укажите индекс'
    if (items.some(it => !it.article.trim() || !(Number(it.quantity) >= 1))) return 'У каждого товара — артикул и количество'
    if (deliveryCost.trim() && !(Number(deliveryCost) >= 0)) return 'Доставка — число'
    return ''
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const v = validate()
    if (v) { setError(v); return }
    if (!confirm('Заказ сразу станет оплаченным: спишется остаток, покупателю и в канал уйдут уведомления, в amoCRM появится сделка, в Почте — заказ. Продолжить?')) return
    setSaving(true)
    setError('')
    try {
      const r = await api.createManualEmsOrder({
        platform,
        customerChatId: chatId.trim() || undefined,
        username: platform === 'telegram' ? username.trim() || undefined : undefined,
        fullName: fullName.trim(),
        phone: phone.trim(),
        recipient: { countryCode: Number(countryCode), region: region.trim(), city: city.trim(), street: street.trim(), index: index.trim() },
        items: items.map(it => ({ article: it.article.trim(), quantity: Number(it.quantity), option: it.option.trim() || undefined })),
        deliveryCost: deliveryCost.trim() ? Number(deliveryCost) : undefined,
        comments: comments.trim() || undefined,
      })
      alert(`Заказ ${r.orderId} заведён: ${fmtMoney(r.total)} (доставка ${fmtMoney(r.deliveryCost)}).\nТеперь назначьте ему дату отправки.`)
      onCreated(r.orderId)
    } catch (e: any) {
      setError(String(e?.message || 'Ошибка').replace(/^invalid_field: /, ''))
    } finally {
      setSaving(false)
    }
  }

  const setItem = (i: number, patch: Partial<ItemDraft>) =>
    setItems(prev => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)))

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content ems-modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        <h2>EMS-заказ вне мини-аппа</h2>
        <p className="stat-muted">
          Для оплаченных заказов из лички или переписки. Цены товаров — из каталога, доставка — по тарифу Почты,
          если не указать, сколько покупатель за неё заплатил. Адрес и ФИО — латиницей, иначе Почта не примет.
        </p>
        <form onSubmit={submit} className="ems-form">
          <fieldset>
            <legend>Покупатель</legend>
            <div className="ems-form-grid">
              <label>Платформа
                <select value={platform} onChange={e => setPlatform(e.target.value as 'telegram' | 'max')}>
                  <option value="telegram">Telegram</option>
                  <option value="max">MAX</option>
                </select>
              </label>
              <label>chat_id (для уведомлений)
                <input value={chatId} onChange={e => setChatId(e.target.value)} placeholder="123456789" inputMode="numeric" />
              </label>
              {platform === 'telegram' && (
                <label>Ник в Telegram
                  <input value={username} onChange={e => setUsername(e.target.value)} placeholder="@username" />
                </label>
              )}
              <label>ФИО латиницей *
                <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Ivanov Ivan" />
              </label>
              <label>Телефон *
                <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+49 ..." />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Адрес</legend>
            <div className="ems-form-grid">
              <label>Страна *
                {countries.length > 0 ? (
                  <select value={countryCode} onChange={e => setCountryCode(e.target.value)}>
                    <option value="">— выберите —</option>
                    {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
                  </select>
                ) : (
                  <input value={countryCode} onChange={e => setCountryCode(e.target.value)} placeholder="код ОКСМ, 860 = Узбекистан" inputMode="numeric" />
                )}
              </label>
              <label>Регион
                <input value={region} onChange={e => setRegion(e.target.value)} placeholder="Bavaria" />
              </label>
              <label>Город *
                <input value={city} onChange={e => setCity(e.target.value)} placeholder="Munich" />
              </label>
              <label>Индекс *
                <input value={index} onChange={e => setIndex(e.target.value)} placeholder="80331" />
              </label>
              <label className="ems-form-wide">Улица, дом, квартира *
                <input value={street} onChange={e => setStreet(e.target.value)} placeholder="Marienplatz 1, apt. 2" />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Товары</legend>
            {items.map((it, i) => (
              <div className="ems-item-row" key={i}>
                <input value={it.article} onChange={e => setItem(i, { article: e.target.value })} placeholder="артикул, 0006" />
                <input value={it.quantity} onChange={e => setItem(i, { quantity: e.target.value })} inputMode="numeric" aria-label="Количество" />
                <input value={it.option} onChange={e => setItem(i, { option: e.target.value })} placeholder="опция, если есть (17)" />
                {items.length > 1 && (
                  <button type="button" className="btn ems-btn-ghost" onClick={() => setItems(prev => prev.filter((_, j) => j !== i))}>×</button>
                )}
              </div>
            ))}
            <button type="button" className="btn ems-btn-ghost" onClick={() => setItems(prev => [...prev, { article: '', quantity: '1', option: '' }])}>
              + товар
            </button>
          </fieldset>

          <div className="ems-form-grid">
            <label>Доставка, ₽
              <input value={deliveryCost} onChange={e => setDeliveryCost(e.target.value)} placeholder="пусто — по тарифу Почты" inputMode="decimal" />
            </label>
            <label className="ems-form-wide">Комментарий
              <input value={comments} onChange={e => setComments(e.target.value)} placeholder="например: оплатил переводом 03.11" />
            </label>
          </div>

          {error && <div className="ems-result ems-result--bad">{error}</div>}
          <div className="ems-form-actions">
            <button type="button" className="btn ems-btn-ghost" onClick={onClose} disabled={saving}>Отмена</button>
            <button type="submit" className="btn ems-btn-primary" disabled={saving}>{saving ? 'Заводим…' : 'Завести оплаченный заказ'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Страница ────────────────────────────────────────────────────────────────────

export default function EmsPage({ onNavigate }: { onNavigate?: (page: AdminPage) => void }) {
  const [orders, setOrders] = useState<EmsOrder[]>([])
  const [today, setToday] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [manualOpen, setManualOpen] = useState(false)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setError('')
    try {
      const d = await api.getEmsOrders()
      setOrders(d.orders || [])
      setToday(d.today)
    } catch (e: any) {
      setError(String(e?.message || 'не удалось загрузить'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleLogout = () => { removeToken(); window.location.reload() }
  const navBtn = (page: AdminPage, label: string, isActive = false) => (
    <button className={`nav-btn${isActive ? ' active' : ''}`} onClick={() => onNavigate?.(page)}>{label}</button>
  )

  const waiting = orders.filter(o => ['no_pochta_order', 'awaiting_date', 'not_paid', 'overdue'].includes(o.stage)).length

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
          {navBtn('shipments', 'Учёт')}
          {navBtn('ems', 'EMS', true)}
          {navBtn('customers', 'Клиенты')}
          {navBtn('settings', 'Настройки')}
        </div>
        <div className="header-actions">
          <button onClick={handleLogout} className="logout-btn">Выйти</button>
        </div>
      </header>

      <div className="ems-page">
        <div className="ems-head">
          <div>
            <h2>EMS — Почта России</h2>
            <div className="stat-muted">
              {loading ? 'Загрузка…' : waiting > 0 ? `Требуют внимания: ${waiting}` : 'Все заказы оформлены'}
            </div>
          </div>
          <div className="ems-head-actions">
            <button className="btn ems-btn-ghost" onClick={() => load()} disabled={loading}>Обновить</button>
            <button className="btn ems-btn-primary" onClick={() => setManualOpen(true)}>＋ Заказ вне мини-аппа</button>
          </div>
        </div>

        <Cheatsheet />

        {loading ? (
          <div className="loading">Спрашиваем Почту…</div>
        ) : error ? (
          <div className="ems-result ems-result--bad">Не удалось загрузить: {error}</div>
        ) : orders.length === 0 ? (
          <div className="stat-empty">Оплаченных EMS-заказов пока нет. Заказы до 03.11 — во вкладке «Статистика → Заказы».</div>
        ) : (
          orders.map(o => <EmsCard key={o.orderId} o={o} today={today} onChanged={() => load(true)} />)
        )}
      </div>

      {manualOpen && (
        <ManualOrderModal
          onClose={() => setManualOpen(false)}
          onCreated={() => {
            setManualOpen(false)
            // заказ в Почте создаётся в фоне после оплаты — даём ему пару секунд
            setTimeout(() => load(true), 3000)
          }}
        />
      )}
    </div>
  )
}
