import pino from 'pino'
import { upsertOrderItems, type ShipmentItem, type ShipStatus, type ShipSource } from './shipment-items-sheet.js'
import { parseAmoCrmComposition, normalizeArticle } from './shipment-items-parser.js'

export type LeadUpsert = {
  orderId: string
  newStatus: ShipStatus
  items: ShipmentItem[]
  shipDate: string
}

const logger = pino()

export const PIPELINE_ID = 10993830

export const STAGE_MAP: Record<number, ShipStatus | 'skip'> = {
  86423882: 'pending',   // Неразобранное
  86486222: 'pending',   // ПРИОРИТЕТНЫЙ ЗАКАЗ — статус pending + флаг priority
  86423886: 'pending',   // НОВЫЙ, ЖДЕТ ОТПРАВКИ
  86486582: 'in_work',   // В РАБОТЕ
  86486586: 'assembled', // Собран
  86462242: 'sent',      // Отправлен
  86423894: 'returned',  // ВОЗВРАЩЕН
  86584502: 'pending',   // САМОВЫВОЗ (env AMOCRM_STAGE_PICKUP_ID) — учитываем как «к отправке»
  142:       'sent',     // Завершён
  143:       'skip',     // Закрыто
}

export const FIELD_ORDER_NUMBER = 774543
export const FIELD_COMPOSITION  = 774547
export const FIELD_SOURCE       = 770993
export const FIELD_ORDER_DATE   = 770485
export const FIELD_DELIVERY_TYPE = 774553
export const FIELD_PRIORITY     = 776409  // чекбокс «Приоритетный заказ» (env AMOCRM_FIELD_PRIORITY_ID)
export const ENUM_TELEGRAM      = 998663
export const ENUM_MAX           = 998667
export const ENUM_TILDA         = 998665
export const STAGE_NEW          = 86423886  // НОВЫЙ, ЖДЕТ ОТПРАВКИ — куда Тильда кидает по умолчанию
export const STAGE_PICKUP       = 86584502  // САМОВЫВОЗ
export const STAGE_PRIORITY     = 86486222  // ПРИОРИТЕТНЫЙ ЗАКАЗ

export function getAmoBase(): string {
  return `https://${process.env.AMOCRM_SUBDOMAIN}.amocrm.ru`
}

export function getAmoToken(): string {
  return process.env.AMOCRM_ACCESS_TOKEN ?? ''
}

export function readField(lead: any, fieldId: number): string | null {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.value
  return v !== undefined && v !== null && v !== '' ? String(v) : null
}

export function readFieldEnum(lead: any, fieldId: number): number | null {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.enum_id
  return v !== undefined ? Number(v) : null
}

export function readFieldBool(lead: any, fieldId: number): boolean {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.value
  return v === true || v === 'true' || v === 1 || v === '1'
}

function toMoscowDate(d: Date): string {
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(0, 10)
}

export function readFieldDate(lead: any, fieldId: number): string {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.value
  if (v && Number(v) > 0) return toMoscowDate(new Date(Number(v) * 1000))
  return ''
}

export function sourceFromEnum(enumId: number | null): ShipSource {
  if (enumId === ENUM_TELEGRAM) return 'telegram'
  if (enumId === ENUM_MAX) return 'max'
  return 'tilda'
}

/**
 * Pure transform: turns a full amoCRM lead into the upsert payload.
 * No I/O — safe to call in a tight loop (used by the bulk sync to avoid
 * hitting Google Sheets read quota per-lead).
 * Returns null if the lead is outside our pipeline or in an ignored stage.
 */
export function prepareLeadUpsert(fullLead: any): LeadUpsert | null {
  const leadId     = Number(fullLead.id)
  const pipelineId = Number(fullLead.pipeline_id)
  const statusId   = Number(fullLead.status_id)

  if (pipelineId !== PIPELINE_ID) return null

  const newStatus = STAGE_MAP[statusId]
  if (!newStatus || newStatus === 'skip') return null

  const orderId        = readField(fullLead, FIELD_ORDER_NUMBER)
  const rawComposition = readField(fullLead, FIELD_COMPOSITION)
  const sourceEnum     = readFieldEnum(fullLead, FIELD_SOURCE)
  const source         = sourceFromEnum(sourceEnum)
  const effectiveOrderId = orderId ?? `AMO-${leadId}`
  const orderDate      = readFieldDate(fullLead, FIELD_ORDER_DATE)
    || toMoscowDate(new Date(fullLead.created_at * 1000))
  // дата отгрузки: updated_at лида (для webhook ≈ сейчас, для catch-up синка — историческая)
  const shipDate       = (newStatus === 'sent' || newStatus === 'returned')
    ? toMoscowDate(new Date((Number(fullLead.updated_at) || Date.now() / 1000) * 1000))
    : ''
  // приоритет — атрибут заказа: этап ПРИОРИТЕТНЫЙ или чекбокс «Приоритетный заказ»
  const priority = (statusId === STAGE_PRIORITY || readFieldBool(fullLead, FIELD_PRIORITY)) ? '1' : ''

  let items: ShipmentItem[] = []
  if (rawComposition) {
    const { items: parsed } = parseAmoCrmComposition(rawComposition)
    items = parsed.map(p => ({
      order_id:    effectiveOrderId,
      source,
      article:     normalizeArticle(p.article),
      qty:         p.qty,
      order_date:  orderDate,
      ship_status: newStatus,
      ship_date:   shipDate,
      title:       String(p.name ?? '').trim(),
      lead_id:     String(leadId),
      priority,
    }))
  }

  return { orderId: effectiveOrderId, newStatus, items, shipDate }
}

/**
 * Processes a single amoCRM lead (must already include custom_fields).
 * Upserts the lead's items into the shipment_items sheet.
 * Returns 'skipped' if the lead is outside our pipeline or in an ignored stage.
 */
export async function processAmoCrmLead(
  fullLead: any
): Promise<'created' | 'updated' | 'noop' | 'skipped'> {
  const prep = prepareLeadUpsert(fullLead)
  if (!prep) return 'skipped'

  const result = await upsertOrderItems(prep.orderId, prep.newStatus, prep.items, prep.shipDate)
  logger.info({ leadId: Number(fullLead.id), effectiveOrderId: prep.orderId, newStatus: prep.newStatus, result }, 'amocrm: lead processed')
  return result
}

/**
 * Strict AND-predicate: true ONLY for a Tilda lead sitting in the «Новый»
 * stage whose delivery type starts with «Самовывоз». Used to auto-route such
 * leads to the dedicated САМОВЫВОЗ stage (Tilda can't do this itself).
 * Anything failing one condition is left untouched — least blast radius.
 * Idempotent by construction: once moved, status != Новый → predicate is false.
 */
export function isTildaPickupInNew(fullLead: any): boolean {
  if (Number(fullLead.pipeline_id) !== PIPELINE_ID) return false
  if (Number(fullLead.status_id) !== STAGE_NEW) return false
  if (readFieldEnum(fullLead, FIELD_SOURCE) !== ENUM_TILDA) return false
  const delivery = (readField(fullLead, FIELD_DELIVERY_TYPE) ?? '').trim().toLowerCase()
  return delivery.startsWith('самовывоз')
}

/**
 * Moves a lead to the САМОВЫВОЗ stage. Touches ONLY status_id (isolation).
 * Throws on non-OK response so the caller can alert.
 */
export async function routeLeadToPickupStage(leadId: number): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(`${getAmoBase()}/api/v4/leads/${leadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${getAmoToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pipeline_id: PIPELINE_ID, status_id: STAGE_PICKUP }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`PATCH lead ${leadId} → ${resp.status}: ${text.slice(0, 200)}`)
    }
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}
