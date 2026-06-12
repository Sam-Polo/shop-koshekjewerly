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

async function amoFetch(method: string, path: string, body?: unknown): Promise<unknown> {
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

// ── Find or create contact ────────────────────────────────────────────────────

async function findOrCreateContact(order: Order): Promise<number> {
  const { fullName, phone, username } = order.orderData
  const chatId = order.customerChatId

  const search = await amoFetch('GET', `/contacts?query=${encodeURIComponent(phone)}&limit=1`) as any
  const existing = search?._embedded?.contacts?.[0]
  if (existing?.id) return existing.id as number

  const customFields: FieldValue[] = []
  const f1 = fieldVal('AMOCRM_CONTACT_FIELD_TG_ID', chatId ? Number(chatId) : null)
  const f2 = fieldVal('AMOCRM_CONTACT_FIELD_TG_USERNAME', username ? `@${username}` : null)
  if (f1) customFields.push(f1)
  if (f2) customFields.push(f2)

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

function buildLeadFields(order: Order): FieldValue[] {
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

  // Состав заказа
  const items = order.orderData.items
    .map(i => `${i.title}${i.quantity > 1 ? ` × ${i.quantity}` : ''} — ${i.price * i.quantity}₽`)
    .join('\n')
  push(fieldVal('AMOCRM_FIELD_ITEMS_ID', items))

  // Адрес доставки
  push(fieldVal('AMOCRM_FIELD_ADDRESS_ID', order.orderData.address || order.orderData.city))
  if (order.orderData.city) push(fieldVal('AMOCRM_FIELD_CITY_ID', order.orderData.city))

  // Имя в заказе и Имя контакта — временно одно и то же (fullName покупателя).
  // В будущем появится разделение: имя покупателя vs имя получателя.
  push(fieldVal('AMOCRM_FIELD_ORDER_NAME_ID', order.orderData.fullName))
  push(fieldVal('AMOCRM_FIELD_CONTACT_NAME_ID', order.orderData.fullName))

  // Тип доставки — временно всегда СДЭК ПВЗ.
  // В будущем: самовывоз, курьер и другие варианты.
  push(fieldVal('AMOCRM_FIELD_DELIVERY_TYPE_ID', 'СДЭК ПВЗ'))

  // Стоимость доставки
  push(fieldVal('AMOCRM_FIELD_DELIVERY_COST_ID', order.orderData.deliveryCost))

  // Комментарий покупателя
  if (order.orderData.comments) push(fieldVal('AMOCRM_FIELD_COMMENT_ID', order.orderData.comments))

  return fields
}

// ── Create lead ───────────────────────────────────────────────────────────────

export async function createAmoCrmLead(order: Order): Promise<number> {
  const pipelineId = Number(process.env.AMOCRM_PIPELINE_ID) || undefined
  const stageId = Number(process.env.AMOCRM_STAGE_TO_SEND_ID) || undefined

  const contactId = await findOrCreateContact(order)

  const leadBody: Record<string, unknown> = {
    name: `${order.orderData.fullName} — ${order.orderData.total}₽`,
    price: order.orderData.total,
    custom_fields_values: buildLeadFields(order),
    _embedded: { contacts: [{ id: contactId, is_main: true }] },
  }
  if (pipelineId) leadBody.pipeline_id = pipelineId
  if (stageId) leadBody.status_id = stageId

  const result = await amoFetch('POST', '/leads', [leadBody]) as any
  const lead = result?._embedded?.leads?.[0]
  if (!lead?.id) throw new Error(`amoCRM: не удалось создать лид, ответ: ${JSON.stringify(result).slice(0, 300)}`)
  return lead.id as number
}

// ── Update lead with CDEK track + link + barcode ─────────────────────────────

export async function updateAmoCrmLeadTrack(leadId: number, cdekTrackNumber: string): Promise<void> {
  const trackingUrl = `https://lk.cdek.ru/order-history/${cdekTrackNumber}/view`
  const fields: FieldValue[] = []
  const f1 = fieldVal('AMOCRM_FIELD_CDEK_TRACK_ID', cdekTrackNumber)
  const f2 = fieldVal('AMOCRM_FIELD_TRACK_LINK_ID', trackingUrl)
  if (f1) fields.push(f1)
  if (f2) fields.push(f2)
  if (!fields.length) return

  await amoFetch('PATCH', `/leads/${leadId}`, { custom_fields_values: fields })
}

export async function updateAmoCrmLeadBarcode(leadId: number, cdekUuid: string, downloadBarcode: (uuid: string) => Promise<Buffer>): Promise<string> {
  const pdfBuffer = await downloadBarcode(cdekUuid)
  const url = await uploadBufferToS3(`cdek-barcodes/${cdekUuid}.pdf`, pdfBuffer, 'application/pdf')
  await setBarcodeUrlInLead(leadId, url)
  return url
}

// ── Set barcode URL in lead url-field ─────────────────────────────────────────

async function setBarcodeUrlInLead(leadId: number, url: string): Promise<void> {
  const f = fieldVal('AMOCRM_FIELD_BARCODE_ID', url)
  if (!f) throw new Error('AMOCRM_FIELD_BARCODE_ID not set')
  await amoFetch('PATCH', `/leads/${leadId}`, { custom_fields_values: [f] })
}

// ── Fire-and-forget wrapper ───────────────────────────────────────────────────

export async function triggerAmoCrmAsync(order: Order): Promise<number | null> {
  try {
    const leadId = await createAmoCrmLead(order)
    return leadId
  } catch (e: any) {
    sendAlert(
      `amoCRM: не удалось создать лид для заказа ${order.orderId}: ${e?.message}`,
      { tag: 'amocrm', level: 'moderate', hint: 'заказ есть в Google Sheets, потеря только в amoCRM', code: 'AMOCRM_LEAD_CREATE_FAILED' }
    ).catch(() => {})
    return null
  }
}
