import pino from 'pino'
import { upsertOrderItems, type ShipmentItem, type ShipStatus, type ShipSource } from './shipment-items-sheet.js'
import { parseAmoCrmComposition, normalizeArticle } from './shipment-items-parser.js'

const logger = pino()

export const PIPELINE_ID = 10993830

export const STAGE_MAP: Record<number, ShipStatus | 'skip'> = {
  86423882: 'pending',   // Неразобранное
  86486222: 'pending',   // ПРИОРИТЕТНЫЙ ЗАКАЗ
  86423886: 'pending',   // НОВЫЙ, ЖДЕТ ОТПРАВКИ
  86486582: 'in_work',   // В РАБОТЕ
  86486586: 'assembled', // Собран
  86462242: 'sent',      // Отправлен
  86423894: 'returned',  // ВОЗВРАЩЕН
  142:       'sent',     // Завершён
  143:       'skip',     // Закрыто
}

export const FIELD_ORDER_NUMBER = 774543
export const FIELD_COMPOSITION  = 774547
export const FIELD_SOURCE       = 770993
export const FIELD_ORDER_DATE   = 770485
export const ENUM_TELEGRAM      = 998663
export const ENUM_MAX           = 998667

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
 * Processes a single amoCRM lead (must already include custom_fields).
 * Upserts the lead's items into the shipment_items sheet.
 * Returns 'skipped' if the lead is outside our pipeline or in an ignored stage.
 */
export async function processAmoCrmLead(
  fullLead: any
): Promise<'created' | 'updated' | 'noop' | 'skipped'> {
  const leadId     = Number(fullLead.id)
  const pipelineId = Number(fullLead.pipeline_id)
  const statusId   = Number(fullLead.status_id)

  if (pipelineId !== PIPELINE_ID) return 'skipped'

  const newStatus = STAGE_MAP[statusId]
  if (!newStatus || newStatus === 'skip') return 'skipped'

  const orderId        = readField(fullLead, FIELD_ORDER_NUMBER)
  const rawComposition = readField(fullLead, FIELD_COMPOSITION)
  const sourceEnum     = readFieldEnum(fullLead, FIELD_SOURCE)
  const source         = sourceFromEnum(sourceEnum)
  const effectiveOrderId = orderId ?? `AMO-${leadId}`
  const orderDate      = readFieldDate(fullLead, FIELD_ORDER_DATE)
    || toMoscowDate(new Date(fullLead.created_at * 1000))
  const shipDate       = (newStatus === 'sent' || newStatus === 'returned')
    ? new Date().toISOString().slice(0, 10)
    : ''

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
    }))
  }

  const result = await upsertOrderItems(effectiveOrderId, newStatus, items, shipDate)
  logger.info({ leadId, effectiveOrderId, newStatus, result }, 'amocrm: lead processed')
  return result
}
