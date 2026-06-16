import { sendAlert } from './alerts.js'
import type { Order } from './orders.js'
import { uploadBufferToS3 } from './s3.js'

const getBase = () => {
  const sub = process.env.AMOCRM_SUBDOMAIN
  if (!sub) throw new Error('AMOCRM_SUBDOMAIN not set')
  return `https://${sub}.amocrm.ru`
}

const getToken = () => {
  const token = process.env.AMOCRM_ACCESS_TOKEN
  if (!token) throw new Error('AMOCRM_ACCESS_TOKEN not set')
  return token
}

// ── Authenticated fetch ───────────────────────────────────────────────────────

async function amoFetch(method: string, path: string, body?: unknown, attempt = 1): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(`${getBase()}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (resp.status === 204) return null
    // amoCRM лимит ~7 req/sec на аккаунт → 429. Ретраим с backoff (учитываем Retry-After).
    if (resp.status === 429 && attempt <= 4) {
      const retryAfter = Number(resp.headers.get('Retry-After'))
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : [500, 1500, 4000, 8000][attempt - 1]
      await sleep(delayMs)
      return amoFetch(method, path, body, attempt + 1)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`amoCRM ${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 300)}`)
    }
    return resp.json()
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── Field helpers ─────────────────────────────────────────────────────────────

type FieldValue = { field_id?: number; field_code?: string; values: Array<{ value?: unknown; enum_id?: number; enum_code?: string }> }

function fieldVal(envKey: string, value: unknown): FieldValue | null {
  const id = Number(process.env[envKey])
  if (!id || value === undefined || value === null || value === '') return null
  return { field_id: id, values: [{ value }] }
}

function fieldEnum(fieldEnvKey: string, enumEnvKey: string): FieldValue | null {
  const fieldId = Number(process.env[fieldEnvKey])
  const enumId = Number(process.env[enumEnvKey])
  if (!fieldId || !enumId) return null
  return { field_id: fieldId, values: [{ enum_id: enumId }] }
}

// ── Env validation — отсутствие ID любого поля CRM = критичный алерт ───────────

const REQUIRED_FIELD_ENV_KEYS = [
  'AMOCRM_FIELD_SOURCE_ID',
  'AMOCRM_ENUM_SOURCE_TELEGRAM',
  'AMOCRM_ENUM_SOURCE_MAX',
  'AMOCRM_FIELD_ORDER_NUMBER_ID',
  'AMOCRM_FIELD_DATE_ID',
  'AMOCRM_FIELD_ITEMS_ID',
  'AMOCRM_FIELD_ADDRESS_ID',
  'AMOCRM_FIELD_CITY_ID',
  'AMOCRM_FIELD_ORDER_NAME_ID',
  'AMOCRM_FIELD_CONTACT_NAME_ID',
  'AMOCRM_FIELD_DELIVERY_TYPE_ID',
  'AMOCRM_FIELD_DELIVERY_COST_ID',
  'AMOCRM_FIELD_COMMENT_ID',
  'AMOCRM_FIELD_PROMOCODE_ID',
  'AMOCRM_FIELD_PRIORITY_ID',
  'AMOCRM_FIELD_CDEK_TRACK_ID',
  'AMOCRM_FIELD_TRACK_LINK_ID',
  'AMOCRM_FIELD_BARCODE_ID',
  'AMOCRM_CONTACT_FIELD_TG_ID',
  'AMOCRM_CONTACT_FIELD_TG_USERNAME',
  'AMOCRM_CONTACT_FIELD_TG_LINK_ID',
] as const

/** Все env-переменные с ID полей amoCRM должны быть заданы. Любая отсутствующая → критичный алерт. */
function checkRequiredFieldEnv(): void {
  const missing = REQUIRED_FIELD_ENV_KEYS.filter(k => {
    const v = process.env[k]
    return !v || Number.isNaN(Number(v)) || Number(v) === 0
  })
  if (missing.length) {
    sendAlert(
      `amoCRM: не заданы env-переменные полей CRM: ${missing.join(', ')} — эти поля не будут заполнены в лиде/контакте`,
      { tag: 'amocrm', level: 'critical', hint: 'добавьте недостающие переменные в Render env', code: 'AMOCRM_FIELD_ENV_MISSING' }
    ).catch(() => {})
  }
}

// ── Find or create contact ────────────────────────────────────────────────────

async function findOrCreateContact(order: Order): Promise<number> {
  const { fullName, phone, username } = order.orderData
  const chatId = order.customerChatId
  const platform = order.platform ?? 'telegram'

  // нормализуем username: ровно один ведущий @
  const cleanUsername = username ? `@${username.replace(/^@/, '')}` : null
  // ссылка на профиль только при наличии username
  const tgUrl = username ? `https://t.me/${username.replace(/^@/, '')}` : null

  // нет username → ссылку на профиль не сохраняем (это норма), но фиксируем low-алертом
  if (!username) {
    sendAlert(
      `amoCRM: у заказа ${order.orderId} нет username — ссылка на профиль не сохранена`,
      { tag: 'amocrm', level: 'low', code: 'AMOCRM_NO_TG_USERNAME' }
    ).catch(() => {})
  }

  const search = await amoFetch('GET', `/contacts?query=${encodeURIComponent(phone)}&limit=1`) as any
  const existing = search?._embedded?.contacts?.[0]
  if (existing?.id) {
    // дозаполняем username и tg-ссылку у вернувшегося клиента (не критично если упадёт)
    const patch: FieldValue[] = []
    const u = fieldVal('AMOCRM_CONTACT_FIELD_TG_USERNAME', cleanUsername)
    const l = fieldVal('AMOCRM_CONTACT_FIELD_TG_LINK_ID', tgUrl)
    if (u) patch.push(u)
    if (l) patch.push(l)
    if (patch.length) {
      await amoFetch('PATCH', `/contacts/${existing.id}`, { custom_fields_values: patch }).catch(() => {})
    }
    return existing.id as number
  }

  const customFields: FieldValue[] = []
  // Telegram ID — только для telegram (для MAX chatId это максовский id, не телеграмный)
  if (platform !== 'max') {
    const fId = fieldVal('AMOCRM_CONTACT_FIELD_TG_ID', chatId ? Number(chatId) : null)
    if (fId) customFields.push(fId)
  }
  const fUser = fieldVal('AMOCRM_CONTACT_FIELD_TG_USERNAME', cleanUsername)
  const fLink = fieldVal('AMOCRM_CONTACT_FIELD_TG_LINK_ID', tgUrl)
  if (fUser) customFields.push(fUser)
  if (fLink) customFields.push(fLink)

  const created = await amoFetch('POST', '/contacts', [
    {
      name: fullName,
      custom_fields_values: [
        { field_code: 'PHONE', values: [{ value: phone, enum_code: 'WORK' }] },
        ...customFields,
      ],
    },
  ]) as any
  const contact = created?._embedded?.contacts?.[0]
  if (!contact?.id) throw new Error(`amoCRM: не удалось создать контакт, ответ: ${JSON.stringify(created).slice(0, 300)}`)
  return contact.id as number
}

// ── Build lead custom fields ──────────────────────────────────────────────────

function buildLeadFields(order: Order, certPromocode?: string): FieldValue[] {
  const fields: FieldValue[] = []
  const push = (f: FieldValue | null) => { if (f) fields.push(f) }

  // Источник — select/enum
  const sourceEnumKey = order.platform === 'max'
    ? 'AMOCRM_ENUM_SOURCE_MAX'
    : 'AMOCRM_ENUM_SOURCE_TELEGRAM'
  push(fieldEnum('AMOCRM_FIELD_SOURCE_ID', sourceEnumKey))

  // Номер заказа
  push(fieldVal('AMOCRM_FIELD_ORDER_NUMBER_ID', order.orderId))

  // Дата — Unix timestamp в секундах
  push(fieldVal('AMOCRM_FIELD_DATE_ID', Math.floor(order.createdAt / 1000)))

  // Состав заказа — артикул в формате [0123] перед названием
  const items = order.orderData.items
    .map(i => {
      const art = i.article ? `[${i.article}] ` : ''
      return `${art}${i.title}${i.quantity > 1 ? ` × ${i.quantity}` : ''} — ${i.price * i.quantity}₽`
    })
    .join('\n')
  const itemsWithPromo = certPromocode
    ? `${items}\nПромокод сертификата: ${certPromocode}`
    : items
  push(fieldVal('AMOCRM_FIELD_ITEMS_ID', itemsWithPromo))

  // Адрес доставки
  if (order.orderData.deliveryMethod === 'ems') {
    const d = order.orderData
    const emsCity = [d.recipientCountry, d.recipientCity].filter(Boolean).join(', ')
    const emsAddress = [d.recipientIndex, d.recipientRegion, d.recipientStreet].filter(Boolean).join(', ')
    if (emsCity) push(fieldVal('AMOCRM_FIELD_CITY_ID', emsCity))
    if (emsAddress) push(fieldVal('AMOCRM_FIELD_ADDRESS_ID', emsAddress))
  } else {
    push(fieldVal('AMOCRM_FIELD_ADDRESS_ID', order.orderData.address || order.orderData.city))
    if (order.orderData.city) push(fieldVal('AMOCRM_FIELD_CITY_ID', order.orderData.city))
  }

  // Имя в заказе и Имя контакта — временно одно и то же (fullName покупателя).
  // В будущем появится разделение: имя покупателя vs имя получателя.
  push(fieldVal('AMOCRM_FIELD_ORDER_NAME_ID', order.orderData.fullName))
  push(fieldVal('AMOCRM_FIELD_CONTACT_NAME_ID', order.orderData.fullName))

  // Тип доставки — по способу доставки заказа.
  const deliveryTypeLabel =
    order.orderData.deliveryMethod === 'pickup' ? 'Самовывоз'
    : order.orderData.deliveryMethod === 'ems' ? 'EMS Почта России'
    : 'СДЭК ПВЗ' // 'cdek' и старые заказы без deliveryMethod
  push(fieldVal('AMOCRM_FIELD_DELIVERY_TYPE_ID', deliveryTypeLabel))

  // Стоимость доставки
  push(fieldVal('AMOCRM_FIELD_DELIVERY_COST_ID', order.orderData.deliveryCost))

  // Комментарий покупателя
  if (order.orderData.comments) push(fieldVal('AMOCRM_FIELD_COMMENT_ID', order.orderData.comments))

  // Использованный промокод (text) — пишем только если применён
  if (order.orderData.promocode?.code) push(fieldVal('AMOCRM_FIELD_PROMOCODE_ID', order.orderData.promocode.code))

  // Приоритетный заказ — checkbox (флаг). Ставим true только для приоритетных.
  if (order.orderData.priorityOrder) push(fieldVal('AMOCRM_FIELD_PRIORITY_ID', true))

  return fields
}

// ── Create lead ───────────────────────────────────────────────────────────────

export async function createAmoCrmLead(order: Order, certPromocode?: string): Promise<number> {
  checkRequiredFieldEnv()

  const pipelineId = Number(process.env.AMOCRM_PIPELINE_ID) || undefined
  const normalStageId = Number(process.env.AMOCRM_STAGE_TO_SEND_ID) || undefined
  const priorityStageId = Number(process.env.AMOCRM_STAGE_PRIORITY_ID) || undefined

  // без воронки лид уйдёт в воронку по умолчанию (не KOSHEK) — заказ «не туда».
  if (!pipelineId) {
    sendAlert(
      `amoCRM: AMOCRM_PIPELINE_ID не задан — лид ${order.orderId} уйдёт в воронку по умолчанию, а не в KOSHEK`,
      { tag: 'amocrm', level: 'high', hint: 'добавьте AMOCRM_PIPELINE_ID в Render env', code: 'AMOCRM_PIPELINE_MISSING' }
    ).catch(() => {})
  }
  // без обычного этапа лид сядет в первый этап воронки, а не в «НОВЫЙ, ЖДЕТ ОТПРАВКИ».
  if (!normalStageId) {
    sendAlert(
      `amoCRM: AMOCRM_STAGE_TO_SEND_ID не задан — лид ${order.orderId} уйдёт в первый этап воронки, а не в «НОВЫЙ, ЖДЕТ ОТПРАВКИ»`,
      { tag: 'amocrm', level: 'high', hint: 'добавьте AMOCRM_STAGE_TO_SEND_ID в Render env', code: 'AMOCRM_STAGE_MISSING' }
    ).catch(() => {})
  }

  // приоритетный заказ → отдельный этап. Если он не настроен, лид уйдёт в обычный
  // этап (флаг 776409 всё равно проставится), но это конфиг-ошибка → high-алерт.
  let stageId = normalStageId
  if (order.orderData.priorityOrder) {
    if (priorityStageId) {
      stageId = priorityStageId
    } else {
      sendAlert(
        `amoCRM: приоритетный заказ ${order.orderId}, но AMOCRM_STAGE_PRIORITY_ID не задан — лид уйдёт в обычный этап`,
        { tag: 'amocrm', level: 'high', hint: 'добавьте AMOCRM_STAGE_PRIORITY_ID в Render env', code: 'AMOCRM_PRIORITY_STAGE_MISSING' }
      ).catch(() => {})
    }
  }

  const contactId = await findOrCreateContact(order)

  // тег по платформе: «макс бот» для MAX, «тг бот» для Telegram
  const tagName = order.platform === 'max' ? 'макс бот' : 'тг бот'

  const leadBody: Record<string, unknown> = {
    name: `${order.orderData.fullName} — ${order.orderData.total}₽`,
    price: order.orderData.total,
    custom_fields_values: buildLeadFields(order, certPromocode),
    _embedded: {
      contacts: [{ id: contactId, is_main: true }],
      tags: [{ name: tagName }],
    },
  }
  if (pipelineId) leadBody.pipeline_id = pipelineId
  if (stageId) leadBody.status_id = stageId

  const result = await amoFetch('POST', '/leads', [leadBody]) as any
  const lead = result?._embedded?.leads?.[0]
  if (!lead?.id) throw new Error(`amoCRM: не удалось создать лид, ответ: ${JSON.stringify(result).slice(0, 300)}`)
  return lead.id as number
}

// ── Update lead with track + link + barcode ──────────────────────────────────

/**
 * Записывает трек-номер и трек-ссылку в лид.
 * Трек-ссылка передаётся явно: для СДЭК — deep-link в ЛК, для EMS — публичное
 * отслеживание Почты. Поле трека (AMOCRM_FIELD_CDEK_TRACK_ID) переиспользуется
 * как общий «трек-номер».
 */
export async function updateAmoCrmLeadTrack(leadId: number, trackNumber: string, trackLink: string): Promise<void> {
  const fields: FieldValue[] = []
  const f1 = fieldVal('AMOCRM_FIELD_CDEK_TRACK_ID', trackNumber)
  const f2 = fieldVal('AMOCRM_FIELD_TRACK_LINK_ID', trackLink)
  if (f1) fields.push(f1)
  if (f2) fields.push(f2)
  if (!fields.length) return

  await amoFetch('PATCH', `/leads/${leadId}`, { custom_fields_values: fields })
}

export async function updateAmoCrmLeadBarcode(
  leadId: number,
  id: string,
  downloadBarcode: (id: string) => Promise<Buffer>,
  keyPrefix = 'cdek-barcodes'
): Promise<string> {
  const pdfBuffer = await downloadBarcode(id)
  const url = await uploadBufferToS3(`${keyPrefix}/${id}.pdf`, pdfBuffer, 'application/pdf')
  await setBarcodeUrlInLead(leadId, url)
  return url
}

// ── Set barcode URL in lead url-field ─────────────────────────────────────────

async function setBarcodeUrlInLead(leadId: number, url: string): Promise<void> {
  const f = fieldVal('AMOCRM_FIELD_BARCODE_ID', url)
  if (!f) throw new Error('AMOCRM_FIELD_BARCODE_ID not set')
  await amoFetch('PATCH', `/leads/${leadId}`, { custom_fields_values: [f] })
}

// ── Find lead by «Номер заказа» + sync CDEK data (used by CDEK webhook) ───────

/** Читает значение текстового кастомного поля из объекта лида (или null если пусто). */
function readLeadField(lead: any, fieldId: number): string | null {
  if (!fieldId) return null
  const cf = lead?.custom_fields_values?.find((f: any) => Number(f.field_id) === fieldId)
  const v = cf?.values?.[0]?.value
  return v !== undefined && v !== null && v !== '' ? String(v) : null
}

export interface LeadCdekState {
  id: number
  track: string | null
  trackLink: string | null
  barcode: string | null
}

/** Ищет лид по полю «Номер заказа» (точное совпадение). query ищет по подстроке — фильтруем сами. */
export async function findLeadByOrderNumber(orderNumber: string): Promise<LeadCdekState | null> {
  const numberFieldId = Number(process.env.AMOCRM_FIELD_ORDER_NUMBER_ID)
  if (!numberFieldId) throw new Error('AMOCRM_FIELD_ORDER_NUMBER_ID not set')
  const search = await amoFetch('GET', `/leads?query=${encodeURIComponent(orderNumber)}&limit=10`) as any
  const leads: any[] = search?._embedded?.leads ?? []
  const lead = leads.find(l => readLeadField(l, numberFieldId) === orderNumber)
  if (!lead?.id) return null
  return {
    id: lead.id as number,
    track:     readLeadField(lead, Number(process.env.AMOCRM_FIELD_CDEK_TRACK_ID)),
    trackLink: readLeadField(lead, Number(process.env.AMOCRM_FIELD_TRACK_LINK_ID)),
    barcode:   readLeadField(lead, Number(process.env.AMOCRM_FIELD_BARCODE_ID)),
  }
}

export type CdekSyncResult =
  | { matched: false }
  | {
      matched: true
      leadId: number
      action: 'other-track-skip' | 'noop' | 'updated'
      wroteTrack: boolean
      wroteLink: boolean
      wroteBarcode: boolean
    }

/**
 * Идемпотентная синхронизация трека/ссылки/штрихкода в лид по номеру заказа.
 * Дозаполняет только ПУСТЫЕ поля. Если в лиде стоит ДРУГОЙ трек — не трогаем.
 * Штрихкод (дорогая операция со скачиванием) качаем только если поле пусто.
 */
export async function syncCdekToLead(
  orderNumber: string,
  cdekNumber: string,
  cdekUuid: string,
  downloadBarcode: (uuid: string) => Promise<Buffer>
): Promise<CdekSyncResult> {
  const lead = await findLeadByOrderNumber(orderNumber)
  if (!lead) return { matched: false }

  // в лиде уже стоит другой трек — это не наш заказ / ручная правка, не перетираем
  if (lead.track && lead.track !== cdekNumber) {
    return { matched: true, leadId: lead.id, action: 'other-track-skip', wroteTrack: false, wroteLink: false, wroteBarcode: false }
  }

  const trackingUrl = `https://lk.cdek.ru/order-history/${cdekNumber}/view`
  const fields: FieldValue[] = []
  let wroteTrack = false
  let wroteLink = false
  if (!lead.track) {
    const f = fieldVal('AMOCRM_FIELD_CDEK_TRACK_ID', cdekNumber)
    if (f) { fields.push(f); wroteTrack = true }
  }
  if (!lead.trackLink) {
    const f = fieldVal('AMOCRM_FIELD_TRACK_LINK_ID', trackingUrl)
    if (f) { fields.push(f); wroteLink = true }
  }
  if (fields.length) await amoFetch('PATCH', `/leads/${lead.id}`, { custom_fields_values: fields })

  let wroteBarcode = false
  if (!lead.barcode) {
    await updateAmoCrmLeadBarcode(lead.id, cdekUuid, downloadBarcode)
    wroteBarcode = true
  }

  const touched = wroteTrack || wroteLink || wroteBarcode
  return { matched: true, leadId: lead.id, action: touched ? 'updated' : 'noop', wroteTrack, wroteLink, wroteBarcode }
}

// ── Fire-and-forget wrapper с ретраями и идемпотентностью ─────────────────────

const AMO_RETRY_DELAYS_MS = [2_000, 5_000] // паузы между 3 попытками

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Гарантированная (насколько возможно) доставка заказа в amoCRM.
 * - Идемпотентность: если лид с этим номером заказа уже есть — не дублируем.
 * - 3 попытки с backoff на случай transient-сбоя amoCRM (502/429/таймаут).
 * - После исчерпания попыток — критичный алерт (заказ есть только в Sheets).
 * Никогда не бросает исключение.
 */
export async function triggerAmoCrmAsync(order: Order, certPromocode?: string): Promise<number | null> {
  // защита от дублей при повторной обработке оплаты / восстановлении из Sheets
  try {
    const existing = await findLeadByOrderNumber(order.orderId)
    if (existing) return existing.id
  } catch {
    // поиск не критичен — если упал, просто пытаемся создать
  }

  let lastErr: any = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await createAmoCrmLead(order, certPromocode)
    } catch (e: any) {
      lastErr = e
      if (attempt < 3) await sleep(AMO_RETRY_DELAYS_MS[attempt - 1])
    }
  }

  sendAlert(
    `amoCRM: НЕ удалось создать лид для заказа ${order.orderId} после 3 попыток: ${lastErr?.message}`,
    { tag: 'amocrm', level: 'critical', hint: 'заказ есть в Google Sheets, но НЕ попал в CRM — создайте лид вручную', code: 'AMOCRM_LEAD_CREATE_FAILED' }
  ).catch(() => {})
  return null
}
