import type { Order } from './orders.js'
import { sendAlert } from './alerts.js'
import { PKG_WEIGHT_G, PKG_LENGTH_CM, PKG_WIDTH_CM, PKG_HEIGHT_CM } from './shipping-constants.js'

// ── API Отправки Почты России (otpravka-api.pochta.ru) ─────────────────────────
// Документация: https://otpravka.pochta.ru/specification#/main
// Авторизация требует ДВА заголовка (одного токена недостаточно):
//   Authorization:        AccessToken <POCHTA_TOKEN>
//   X-User-Authorization: Basic <base64(login:password)>
//
// ВНИМАНИЕ: точные имена ряда JSON-полей международного EMS-заказа и структура
// customs-declaration (CN23) подлежат сверке со спецификацией при первом боевом
// прогоне. Все ключи вынесены в build-функции ниже и снабжены комментариями.

const POCHTA_BASE = (process.env.POCHTA_API_BASE ?? 'https://otpravka-api.pochta.ru').replace(/\/$/, '')

// ОКСМ-код страны происхождения товаров (Россия) для таможенной декларации
const ORIGIN_COUNTRY_CODE = 643
// валюта объявленной ценности/декларации
const DECLARATION_CURRENCY = 'RUB'

const getMailType = () => process.env.POCHTA_MAIL_TYPE ?? 'EMS'
// EMS идёт категорией ORDINARY (обыкновенное); WITH_DECLARED_VALUE для EMS не поддерживается (тариф=0)
const getMailCategory = () => process.env.POCHTA_MAIL_CATEGORY ?? 'ORDINARY'
// код ТН ВЭД — полный 10-значный (7117190000 = бижутерия из недрагметаллов); '7117' (группа) API отклоняет
const getTnvedCode = () => process.env.POCHTA_TNVED_CODE ?? '7117190000'
// наименование товара в таможенной декларации CN23 — только латиница, и достаточной длины (API отклоняет короткое)
const getCustomsDescription = () => process.env.POCHTA_CUSTOMS_DESCRIPTION ?? 'Jewellery (fashion accessories)'
const getIndexFrom = () => process.env.POCHTA_INDEX_FROM ?? ''

// ── Env validation — отсутствие любой обязательной переменной = критичный алерт ─

const REQUIRED_POCHTA_ENV_KEYS = [
  'POCHTA_TOKEN',
  'POCHTA_LOGIN',
  'POCHTA_PASSWORD',
  'POCHTA_INDEX_FROM',
] as const

/**
 * Проверяет, заданы ли обязательные env Почты. Любая отсутствующая → критичный алерт
 * (sendAlert дедуплицирует по code, поэтому повторные вызовы не спамят канал).
 * Возвращает false, если чего-то не хватает (EMS-отправление создавать бессмысленно).
 */
export function checkRequiredPochtaEnv(): boolean {
  const missing = REQUIRED_POCHTA_ENV_KEYS.filter(k => !process.env[k])
  if (missing.length) {
    sendAlert(
      `Pochta: не заданы env-переменные: ${missing.join(', ')} — EMS-отправление не будет создано`,
      { tag: 'pochta', level: 'critical', hint: 'добавьте недостающие переменные в Render env', code: 'POCHTA_ENV_MISSING' }
    ).catch(() => {})
    return false
  }
  return true
}

// ── Auth ────────────────────────────────────────────────────────────────────

let _cachedBasic: string | null = null

// exported for tests
export function _resetAuthCache() {
  _cachedBasic = null
}

function getBasicKey(): string {
  if (_cachedBasic) return _cachedBasic
  const login = process.env.POCHTA_LOGIN
  const password = process.env.POCHTA_PASSWORD
  if (!login || !password) throw new Error('POCHTA_LOGIN / POCHTA_PASSWORD not set')
  _cachedBasic = Buffer.from(`${login}:${password}`).toString('base64')
  return _cachedBasic
}

function getAuthHeaders(): Record<string, string> {
  const token = process.env.POCHTA_TOKEN
  if (!token) throw new Error('POCHTA_TOKEN not set')
  return {
    Authorization: `AccessToken ${token}`,
    'X-User-Authorization': `Basic ${getBasicKey()}`,
  }
}

// ── Authenticated fetch ───────────────────────────────────────────────────────

export async function pochtaFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(`${POCHTA_BASE}${path}`, {
      method,
      headers: {
        ...getAuthHeaders(),
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json;charset=UTF-8',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Pochta ${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 300)}`)
    }
    return resp.json()
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── Тарификатор ───────────────────────────────────────────────────────────────

/**
 * Расчёт стоимости международной EMS-доставки.
 * POST /1.0/tariff — ответ в копейках (total-rate без НДС + total-vat).
 * @param countryCode ОКСМ числовой код страны получателя (mail-direct)
 * @param weight вес в граммах (по умолчанию фикс-вес посылки)
 */
export async function calculateTariff(countryCode: number, weight = PKG_WEIGHT_G): Promise<number> {
  const indexFrom = getIndexFrom()
  if (!indexFrom) throw new Error('POCHTA_INDEX_FROM not set')

  const data = await pochtaFetch('POST', '/1.0/tariff', {
    'index-from': indexFrom,
    'mail-category': getMailCategory(),
    'mail-type': getMailType(),
    'mail-direct': countryCode,
    mass: weight,
    dimension: { height: PKG_HEIGHT_CM, length: PKG_LENGTH_CM, width: PKG_WIDTH_CM },
  }) as any

  const rate = data?.['total-rate']
  if (typeof rate !== 'number') {
    const errors = data?.errors ?? data
    throw new Error(`Pochta tariff: no total-rate. Response: ${JSON.stringify(errors).slice(0, 300)}`)
  }
  const vat = typeof data?.['total-vat'] === 'number' ? data['total-vat'] : 0
  // копейки → рубли
  return Math.ceil((rate + vat) / 100)
}

// ── Справочник стран (публичный калькулятор, без авторизации) ──────────────────
// tariff.pochta.ru/v1/dictionary/country отдаёт актуальный список направлений Почты.
// id страны == код ОКСМ (276=Германия, 840=США …) — он же идёт как mail-direct.
// Открытый эндпоинт (CORS нет → ходим с бэкенда), кэшируем на 24ч.

export interface PochtaCountry { code: number; name: string }

const COUNTRY_DICT_URL = 'https://tariff.pochta.ru/v1/dictionary/country'
let _countriesCache: PochtaCountry[] | null = null
let _countriesExpiresAt = 0

// exported for tests
export function _resetCountriesCache() {
  _countriesCache = null
  _countriesExpiresAt = 0
}

/** «ГЕРМАНИЯ» → «Германия», «СОЕДИНЕННЫЕ ШТАТЫ» → «Соединенные Штаты». */
function titleCaseCountry(s: string): string {
  return s.toLowerCase().replace(/(^|[\s\-(«])([а-яёa-z])/g, (_, p, c) => p + (c as string).toUpperCase())
}

export async function getCountries(): Promise<PochtaCountry[]> {
  if (_countriesCache && Date.now() < _countriesExpiresAt) return _countriesCache

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(COUNTRY_DICT_URL, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!resp.ok) throw new Error(`Pochta countries HTTP ${resp.status}`)
    const data = await resp.json() as any
    const list = Array.isArray(data?.country) ? data.country : []
    const mapped: PochtaCountry[] = list
      .filter((x: any) => typeof x?.id === 'number' && x?.name)
      .map((x: any) => ({ code: x.id as number, name: titleCaseCountry(String(x.name)) }))
      .sort((a: PochtaCountry, b: PochtaCountry) => a.name.localeCompare(b.name, 'ru'))
    if (!mapped.length) throw new Error('Pochta countries: пустой справочник')
    _countriesCache = mapped
    _countriesExpiresAt = Date.now() + 24 * 3600 * 1000
    return mapped
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── Создание заказа в backlog ──────────────────────────────────────────────────

export interface PochtaOrderResult {
  /** внутренний result-id заказа в backlog Почты */
  id: number
}

/** Строит позиции таможенной декларации CN23 из товаров заказа. */
function buildCustomsEntries(order: Order) {
  const items = order.orderData.items
  const tnved = getTnvedCode()
  const description = getCustomsDescription()
  // распределяем фикс-вес посылки по позициям (как в cdek.ts)
  const perItemWeight = Math.max(1, Math.round(PKG_WEIGHT_G / Math.max(1, items.length)))
  return items.map(item => ({
    // наименование для таможни — латиница (item.title кириллицей таможня отклоняет)
    description,
    amount: item.quantity,
    weight: perItemWeight,
    // стоимость позиции в копейках
    value: Math.round(item.price * item.quantity * 100),
    'country-code': ORIGIN_COUNTRY_CODE,
    'tnved-code': tnved,
  }))
}

/**
 * Создаёт международный EMS-заказ в backlog Почты.
 * PUT /1.0/user/backlog (массив с одним заказом) → { result-ids: [id] }.
 * Имена полей международного адреса/декларации — сверить со спецификацией.
 */
export async function createPochtaOrder(order: Order): Promise<PochtaOrderResult> {
  const d = order.orderData
  const indexFrom = getIndexFrom()
  if (!indexFrom) throw new Error('POCHTA_INDEX_FROM not set')
  if (!d.recipientCountryCode) throw new Error('recipientCountryCode (ОКСМ) не задан для EMS-заказа')

  // ФИО получателя: грубое разбиение fullName на surname / given-name
  const nameParts = (d.fullName || '').trim().split(/\s+/)
  const surname = nameParts[0] ?? ''
  const givenName = nameParts.slice(1).join(' ') || surname

  // объявленная ценность = сумма товаров (копейки)
  const itemsTotal = d.items.reduce((s, it) => s + it.price * it.quantity, 0)

  // EMS идёт категорией ORDINARY (обыкновенное); объявленную ценность шлём только
  // для declared-value категорий, иначе API ругается (EMS WITH_DECLARED_VALUE не поддерживается)
  const mailCategory = getMailCategory()
  const isDeclaredValue = mailCategory.includes('DECLARED_VALUE')

  const orderBody = {
    'order-num': order.orderId.slice(0, 40),
    'address-type-to': 'DEFAULT',
    'mail-category': mailCategory,
    'mail-type': getMailType(),
    'mail-direct': d.recipientCountryCode,
    mass: PKG_WEIGHT_G,
    dimension: { height: PKG_HEIGHT_CM, length: PKG_LENGTH_CM, width: PKG_WIDTH_CM },
    'postoffice-code': indexFrom,
    // получатель (физлицо за рубежом)
    surname,
    'given-name': givenName,
    'tel-address': Number((d.phone || '').replace(/\D/g, '')) || undefined,
    // зарубежный адрес
    'country-code': d.recipientCountryCode,
    'region-to': d.recipientRegion || undefined,
    'place-to': d.recipientCity || undefined,
    'str-index-to': d.recipientIndex || undefined,
    'street-to': d.recipientStreet || undefined,
    // объявленная ценность (копейки) — только для категорий с объявленной ценностью
    ...(isDeclaredValue ? { 'insr-value': Math.round(itemsTotal * 100) } : {}),
    // таможенная декларация CN23
    'customs-declaration': {
      currency: DECLARATION_CURRENCY,
      'entries-type': 'SALE_OF_GOODS',
      'customs-entries': buildCustomsEntries(order),
    },
  }

  const data = await pochtaFetch('PUT', '/1.0/user/backlog', [orderBody]) as any
  const id = data?.['result-ids']?.[0]
  if (typeof id !== 'number') {
    const errors = data?.errors ?? data
    throw new Error(`Pochta createOrder: no result-id. Response: ${JSON.stringify(errors).slice(0, 300)}`)
  }
  return { id }
}

// ── Создание партии (присвоение ШПИ) ───────────────────────────────────────────

export interface PochtaBatchResult {
  batchName: string
  shpi: string | null
}

/**
 * Формирует партию из заказов backlog — Почта присваивает ШПИ.
 * POST /1.0/user/shipment (массив result-id) → [{ batch-name }].
 * use-online-balance=true обязателен: аккаунт работает на онлайн-балансе, без
 * признака партия уходит на «классическую» схему оплаты (выключена) и печатные
 * формы отдают 403 (указание техподдержки Почты, июль 2026).
 */
export async function createBatch(resultIds: number[]): Promise<string> {
  const data = await pochtaFetch('POST', '/1.0/user/shipment?use-online-balance=true', resultIds) as any
  const batchName = Array.isArray(data)
    ? data[0]?.['batch-name']
    : data?.['batch-name'] ?? data?.batches?.[0]?.['batch-name']
  if (!batchName) {
    throw new Error(`Pochta createBatch: no batch-name. Response: ${JSON.stringify(data).slice(0, 300)}`)
  }
  return batchName as string
}

/** Путь к заказам партии (с ШПИ). /1.0/batch/{name} — это метаданные партии, а заказы — на /shipment. */
function batchShipmentsPath(batchName: string): string {
  return `/1.0/batch/${encodeURIComponent(batchName)}/shipment?size=50&page=0`
}

/**
 * Читает ШПИ (barcode) первого заказа партии.
 * GET /1.0/batch/{name}/shipment → заказы партии; у каждого поле barcode (ШПИ).
 */
export async function getShpiFromBatch(batchName: string): Promise<string | null> {
  const data = await pochtaFetch('GET', batchShipmentsPath(batchName)) as any
  // ответ может быть массивом заказов либо объектом с вложенным списком — поддержим оба
  const list = Array.isArray(data)
    ? data
    : (data?.shipments ?? data?.orders ?? data?.['result-orders'] ?? data?.content ?? [])
  const first = Array.isArray(list) ? list[0] : null
  const barcode = first?.barcode ?? first?.['barcode-orig']
  return (barcode as string) ?? null
}

/** Путь чтения заказов партии — для диагностики в тест-эндпоинте. */
export function _batchShipmentsPath(batchName: string): string {
  return batchShipmentsPath(batchName)
}

// ── Печать ярлыка Ф7п (PDF) ─────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

/**
 * Скачивает печатные формы заказа (PDF) по идентификатору ЗАКАЗА (backlog id).
 * GET /1.0/forms/{order-id}/forms — общий комплект форм заказа; для международных
 * отправлений включает нужные бланки (CP71/CN23). Домашний /f7pdf для международки
 * отдаёт 403 Access Denied — он только для внутренних отправлений.
 */
export async function downloadF7p(orderId: string | number): Promise<Buffer> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const resp = await fetch(`${POCHTA_BASE}/1.0/forms/${encodeURIComponent(String(orderId))}/forms`, {
      headers: { ...getAuthHeaders(), Accept: 'application/pdf' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Pochta f7pdf HTTP ${resp.status}: ${text.slice(0, 200)}`)
    }
    const buf = await resp.arrayBuffer()
    return Buffer.from(buf)
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── High-level: создать отправление с ретраями + поллингом ШПИ ─────────────────

const RETRY_DELAYS_MS = [2_000, 4_000]

/**
 * Создаёт EMS-отправление и вызывает onTrackReady(shpi, batchName) при получении ШПИ.
 * Зеркало triggerCdekOrderAsync: 3 попытки на создание, поллинг ШПИ, алерты при сбоях.
 * Никогда не бросает (все ошибки → sendAlert).
 */
export async function triggerPochtaOrderAsync(
  order: Order,
  onTrackReady: (shpi: string, batchName: string, pochtaOrderId: number) => Promise<void>
): Promise<void> {
  // обязательные env должны быть заданы — иначе отправление не создать
  if (!checkRequiredPochtaEnv()) return

  if (!order.orderData.recipientCountryCode) {
    sendAlert(
      `Pochta: recipientCountryCode не задан для заказа ${order.orderId}`,
      { tag: 'pochta', level: 'high', hint: 'EMS-отправление не создано — менеджер должен создать вручную', code: 'POCHTA_NO_COUNTRY' }
    ).catch(() => {})
    return
  }

  // 1. создать заказ в backlog (до 3 попыток)
  let resultId: number | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await createPochtaOrder(order)
      resultId = r.id
      break
    } catch (e: any) {
      if (attempt < 3) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
      } else {
        sendAlert(
          `Pochta: не удалось создать EMS-заказ ${order.orderId} после 3 попыток: ${e?.message}`,
          { tag: 'pochta', level: 'high', hint: 'менеджер должен создать отправление в ЛК Почты вручную', code: 'POCHTA_ORDER_CREATE_FAILED' }
        ).catch(() => {})
        return
      }
    }
  }
  if (resultId === null) return

  // 2. сформировать партию (присваивается ШПИ) — до 3 попыток
  let batchName: string | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      batchName = await createBatch([resultId])
      break
    } catch (e: any) {
      if (attempt < 3) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
      } else {
        sendAlert(
          `Pochta: заказ ${order.orderId} создан (id=${resultId}), но партия не сформирована за 3 попытки: ${e?.message}`,
          { tag: 'pochta', level: 'high', hint: 'сформируйте партию в ЛК Почты вручную, чтобы получить ШПИ', code: 'POCHTA_BATCH_FAILED' }
        ).catch(() => {})
        return
      }
    }
  }
  if (!batchName) return

  // 3. получить ШПИ (поллинг до 5 раз с интервалом 5с)
  let shpi: string | null = null
  for (let i = 0; i < 5; i++) {
    try {
      shpi = await getShpiFromBatch(batchName)
      if (shpi) break
    } catch {}
    await sleep(5_000)
  }

  if (shpi) {
    await onTrackReady(shpi, batchName, resultId).catch((e: any) => {
      sendAlert(
        `Pochta: ШПИ ${shpi} получен для ${order.orderId}, но onTrackReady упал: ${e?.message}`,
        { tag: 'pochta', level: 'moderate', code: 'POCHTA_TRACK_CALLBACK_FAILED' }
      ).catch(() => {})
    })
  } else {
    sendAlert(
      `Pochta: заказ ${order.orderId} создан (партия ${batchName}), ШПИ не присвоен за 25с. Трек придёт позже.`,
      { tag: 'pochta', level: 'info', hint: 'проверьте ШПИ в ЛК Почты через несколько минут', code: 'POCHTA_NO_TRACK_YET' }
    ).catch(() => {})
  }
}
