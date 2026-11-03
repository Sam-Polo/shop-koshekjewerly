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
// габариты передаём только для EMS: мелкий пакет (SMALL_PACKET) тарифицируется
// только по весу, API отклоняет dimension с DIMENSION_NOT_SUPPORTED
const usesDimensions = () => getMailType().toUpperCase().startsWith('EMS')
// EMS идёт категорией ORDINARY (обыкновенное); WITH_DECLARED_VALUE для EMS не поддерживается (тариф=0)
const getMailCategory = () => process.env.POCHTA_MAIL_CATEGORY ?? 'ORDINARY'
// код ТН ВЭД — полный 10-значный (7117190000 = бижутерия из недрагметаллов); '7117' (группа) API отклоняет
const getTnvedCode = () => process.env.POCHTA_TNVED_CODE ?? '7117190000'
// наименование товара в таможенной декларации CN23 — только латиница, и достаточной длины (API отклоняет короткое).
// «Clay jewerly» — как заполняет заказчик при ручном оформлении (проверено живым тестом 2026-07).
// Прежний вариант, если захотим вернуться: 'Jewellery (fashion accessories)'
const getCustomsDescription = () => process.env.POCHTA_CUSTOMS_DESCRIPTION ?? 'Clay jewerly'
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
 * (sendAlert гасит одинаковый текст в течение 60 с, поэтому повторные вызовы не спамят канал).
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
      // status — чтобы вызывающий код отличал отказ в доступе (креды) от сбоя самой Почты
      throw Object.assign(
        new Error(`Pochta ${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 300)}`),
        { status: resp.status },
      )
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
    ...(usesDimensions() ? { dimension: { height: PKG_HEIGHT_CM, length: PKG_LENGTH_CM, width: PKG_WIDTH_CM } } : {}),
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

/**
 * Алерт о сбое расчёта стоимости для покупателя (ручка /api/pochta/calculate).
 *
 * Без суммы доставки мини-апп не даёт оформить международный заказ, так что каждый
 * такой сбой — покупатель, упёршийся в «Ошибку расчёта». Пост-оплатные алерты
 * (ems-shipping.ts) тут не помогут: до оплаты никто не доходит, им нечего ловить.
 * Так и вышло 02.11.2026: на Render остался старый пароль ЛК, каждый расчёт получал 401,
 * международка лежала, вероятно, с сентября — и в канале ни строчки.
 *
 * Отказ в доступе (401/403) и незаданные env сами не пройдут → critical.
 * Остальное (таймаут, 5xx Почты) бывает разовым → high.
 * «Страна недоступна» (нулевой тариф) сюда не попадает: это штатный 422 в ручке.
 */
export function alertTariffFailure(e: unknown, countryCode: number): void {
  const status = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined
  const message = e instanceof Error ? e.message : String(e)
  const configBroken =
    status === 401 || status === 403 || REQUIRED_POCHTA_ENV_KEYS.some(k => !process.env[k])

  sendAlert(
    // постоянная часть — в начале: дедуп сравнивает первые 150 символов текста, и при
    // массовом сбое попытки по разным странам схлопываются в один алерт
    `Pochta: не удалось рассчитать стоимость доставки — покупатель не может оформить международный заказ. ${message} (код страны ${countryCode})`,
    configBroken
      ? {
          tag: 'pochta', level: 'critical', code: 'POCHTA_TARIFF_CONFIG',
          hint: 'не те креды или env Почты на Render (пароль ЛК меняют сразу в двух местах: локальный .env и Render)',
        }
      : {
          tag: 'pochta', level: 'high', code: 'POCHTA_TARIFF_FAILED',
          hint: 'Почта не ответила или вернула ошибку; если алерт повторяется — международное оформление лежит',
        },
  ).catch(() => {})
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
    ...(usesDimensions() ? { dimension: { height: PKG_HEIGHT_CM, length: PKG_LENGTH_CM, width: PKG_WIDTH_CM } } : {}),
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
 *
 * use-online-balance=true обязателен: «классическая» схема (оплата при сдаче в
 * отделении) на аккаунте выключена — без флага ЛК отказывает по всей партии
 * («Оплата отправлений по классической схеме выключена»), проверено 04.08.2026.
 *
 * Флаг здесь только помечает партию (в ответе `use-online-balance: true`), деньги
 * списывает checkinBatch — и у него СВОЙ параметр с другим именем, см. там.
 * Подробности и матрица проверок: docs/integrations/pochta-ems.md.
 */
export async function createBatch(resultIds: number[], sendingDate?: string): Promise<string> {
  // дата сдачи печатается на документах и задаёт день, когда отделение ждёт партию;
  // без неё Почта ставит день создания партии
  const query = `use-online-balance=true${sendingDate ? `&sending-date=${sendingDate}` : ''}`
  const data = await pochtaFetch('POST', `/1.0/user/shipment?${query}`, resultIds) as any
  const batchName = Array.isArray(data)
    ? data[0]?.['batch-name']
    : data?.['batch-name'] ?? data?.batches?.[0]?.['batch-name']
  if (!batchName) {
    // отказ приходит HTTP 200 со списком errors (например PAST_DUE_DATE) — код нужен админке
    const code = data?.errors?.[0]?.['error-code']
    throw Object.assign(
      new Error(`Pochta createBatch: no batch-name. Response: ${JSON.stringify(data).slice(0, 300)}`),
      { code: typeof code === 'string' ? code : null },
    )
  }
  return batchName as string
}

export interface PochtaBatchInfo {
  name: string
  /** CREATED → FROZEN (идёт приём) → ACCEPTED (принята в отделении) → SENT (есть трекинг) → ARCHIVED */
  status: string
  statusDate: string | null
  /** номер ф.103 — присваивается только успешным checkin'ом */
  listNumber: number | null
  /** дата сдачи в отделение (yyyy-MM-dd); есть и до checkin */
  sendingDate: string | null
}

/** Метаданные партии: GET /1.0/batch/{name}. ШПИ здесь нет — он у заказов партии. */
export async function getBatch(batchName: string): Promise<PochtaBatchInfo> {
  const data = await pochtaFetch('GET', `/1.0/batch/${encodeURIComponent(batchName)}`) as any
  if (!data?.['batch-name']) {
    throw new Error(`Pochta getBatch ${batchName}: пустой ответ ${JSON.stringify(data).slice(0, 200)}`)
  }
  return {
    name: String(data['batch-name']),
    status: String(data['batch-status'] ?? ''),
    statusDate: data['batch-status-date'] ?? null,
    listNumber: typeof data['list-number'] === 'number' ? data['list-number'] : null,
    sendingDate: data['list-number-date'] ?? null,
  }
}

/**
 * Меняет дату сдачи партии: POST /1.0/batch/{name}/sending/{год}/{месяц}/{день}.
 * Если checkin уже был, Почта заново шлёт ф.103 в отделение (f103-sent: true) —
 * документы с прежней датой после этого недействительны, их надо перекачать.
 */
export async function setBatchSendingDate(batchName: string, date: string): Promise<PochtaCheckinResult> {
  const [y, m, d] = date.split('-').map(Number)
  const data = await pochtaFetch('POST', `/1.0/batch/${encodeURIComponent(batchName)}/sending/${y}/${m}/${d}`) as any
  return {
    f103Sent: data?.['f103-sent'] === true,
    errorCode: (data?.['error-code'] as string) ?? null,
  }
}

export interface PochtaShipmentInfo {
  /** внутренний id отправления — тот же, что result-id заказа в backlog */
  id: number
  orderNum: string
  barcode: string | null
  batchName: string | null
  batchStatus: string | null
  /** последняя операция трекинга (появляется после приёма в отделении) */
  operationName: string | null
  lastOperDate: string | null
}

/**
 * Ищет отправление (заказ, уже перенесённый в партию) по нашему номеру заказа.
 * GET /1.0/shipment/search?query= ищет по order-num или ШПИ точным совпадением
 * (проверено 04.11.2026: обрезанный номер не находит ничего). Заказ, который ещё
 * лежит в backlog, здесь не виден — для него findBacklogOrderByOrderNum.
 */
export async function findShipmentByOrderNum(orderNum: string): Promise<PochtaShipmentInfo | null> {
  const data = await pochtaFetch('GET', `/1.0/shipment/search?query=${encodeURIComponent(orderNum)}`) as any
  const list: any[] = Array.isArray(data) ? data : []
  const hit = list.find(x => x?.['order-num'] === orderNum)
  if (!hit || typeof hit.id !== 'number') return null
  return {
    id: hit.id,
    orderNum,
    barcode: hit.barcode ?? null,
    batchName: hit['batch-name'] != null ? String(hit['batch-name']) : null,
    batchStatus: hit['batch-status'] ?? null,
    operationName: hit['human-operation-name'] ?? null,
    lastOperDate: hit['last-oper-date'] ?? null,
  }
}

/** Ищет заказ в backlog (ещё без партии) по нашему номеру заказа → его result-id. */
export async function findBacklogOrderByOrderNum(orderNum: string): Promise<number | null> {
  const data = await pochtaFetch('GET', `/1.0/backlog/search?query=${encodeURIComponent(orderNum)}`) as any
  const list: any[] = Array.isArray(data) ? data : []
  const hit = list.find(x => x?.['order-num'] === orderNum)
  return typeof hit?.id === 'number' ? hit.id : null
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

// ── Checkin партии (присвоение номера списка) ─────────────────────────────────

export interface PochtaCheckinResult {
  /** сформирован ли ф.103 — единственный надёжный признак успеха */
  f103Sent: boolean
  /** код отказа Почты, если checkin не прошёл (напр. NOT_ENOUGH_FUNDS) */
  errorCode: string | null
}

/**
 * Регистрирует партию к сдаче: POST /1.0/batch/{name}/checkin?useOnlineBalance=true.
 * По спеке: «присваивает уникальную версию партии для дальнейшего приёма этой
 * партии сотрудниками ОПС; отправляет электронную форму Ф103 в ОПС для регистрации».
 *
 * ОБЯЗАТЕЛЬНЫЙ шаг, которого в пайплайне не было до 15.09.2026. Без него партии
 * навсегда остаются в статусе CREATED, номер списка не присваивается, ф.103 не
 * формируется (`1013 EMPTY_LIST_NUMBER`), и — главное — **отправление не
 * зарегистрировано в системе отделения**: на пункте по ШПИ ничего не находят и
 * отказывают в приёме со словами «у вас партионка».
 *
 * Имя параметра — `useOnlineBalance` (camelCase), а НЕ `use-online-balance`, как у
 * создания партии: в спеке у checkin параметр объявлен без prefix. С чужим именем
 * Почта его молча игнорирует и пытается оплатить партию офлайн →
 * `OFFLINE_BALANCE_FORBIDDEN` (классическая схема на аккаунте выключена). На этом
 * застряли с 15.09 по 02.11.2026.
 *
 * Отвечает HTTP 200 и в случае отказа тоже — успех определяется полем f103-sent,
 * а не статусом ответа. Ожидаемый отказ: `NOT_ENOUGH_FUNDS` — на онлайн-балансе
 * меньше стоимости пересылки партии. Именно на этом шаге списываются деньги.
 */
export async function checkinBatch(batchName: string): Promise<PochtaCheckinResult> {
  const data = await pochtaFetch('POST', `/1.0/batch/${encodeURIComponent(batchName)}/checkin?useOnlineBalance=true`) as any
  return {
    f103Sent: data?.['f103-sent'] === true,
    errorCode: (data?.['error-code'] as string) ?? null,
  }
}

/**
 * Скачивает партионный реестр ф.103 (PDF) — документ, который несут на почту вместе
 * с посылкой, чтобы отделение приняло партию.
 *
 * ВНИМАНИЕ к пути: `/1.0/forms/{batch-name}/f103pdf` — БЕЗ сегмента `batch`.
 * Неверный путь `/1.0/forms/batch/{name}/f103pdf` не существует, но при
 * `Accept: application/pdf` шлюз Почты отвечает на него ложным
 * `403 UNAUTHORIZED` вместо 404 — на этом потеряли полтора месяца переписки
 * с техподдержкой (см. docs/integrations/pochta-ems.md).
 *
 * Требует пройденного checkinBatch, иначе `1013 EMPTY_LIST_NUMBER`.
 */
export async function downloadF103(batchName: string): Promise<Buffer> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const resp = await fetch(`${POCHTA_BASE}/1.0/forms/${encodeURIComponent(batchName)}/f103pdf`, {
      headers: { ...getAuthHeaders(), Accept: 'application/pdf' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Pochta f103 HTTP ${resp.status}: ${text.slice(0, 200)}`)
    }
    return Buffer.from(await resp.arrayBuffer())
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── Печать ярлыка Ф7п (PDF) ─────────────────────────────────────────────────

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
