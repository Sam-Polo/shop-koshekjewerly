/**
 * One-off script: import ~700 historical leads from amoCRM into the shipment_items sheet.
 *
 * For each lead in pipeline 10993830:
 *   - reads composition from field 774547 (text)
 *   - parses article+qty via parseAmoCrmComposition()
 *   - maps stage_id to ship_status
 *   - appends rows to shipment_items sheet
 *   - logs unrecognized entries for manual review
 *
 * Usage:
 *   npx tsx src/scripts/import-shipment-items.ts [--dry-run] [--limit N]
 *
 * --dry-run  Parse and log without writing to Sheets
 * --limit N  Process only the first N leads (for testing)
 */

import 'dotenv/config'
import { parseAmoCrmComposition } from '../shipment-items-parser.js'
import { ensureShipmentItemsSheet, appendShipmentItems, type ShipmentItem, type ShipStatus, type ShipSource } from '../shipment-items-sheet.js'

// ── amoCRM config ─────────────────────────────────────────────────────────────

const AMO_BASE = `https://${process.env.AMOCRM_SUBDOMAIN}.amocrm.ru`
const AMO_TOKEN = process.env.AMOCRM_ACCESS_TOKEN!
const PIPELINE_ID = 10993830

// Stage → ship_status mapping. Snapshot 14.06.2026 — verify before running!
// See GOODS_TRACKING_PLAN.md §7
const STAGE_MAP: Record<number, ShipStatus | 'skip'> = {
  86423882: 'pending',  // Неразобранное
  86486222: 'pending',  // ПРИОРИТЕТНЫЙ ЗАКАЗ
  86423886: 'pending',  // НОВЫЙ, ЖДЕТ ОТПРАВКИ
  86486582: 'pending',  // В РАБОТЕ
  86486586: 'pending',  // Собран
  86462242: 'sent',     // Отправлен
  86423894: 'returned', // ВОЗВРАЩЕН
  142:       'sent',    // Завершён (success)
  143:       'skip',    // Закрыто — не учитываем
}

const FIELD_ORDER_NUMBER = 774543   // № заказа
const FIELD_COMPOSITION  = 774547   // Состав (текст)
const FIELD_SOURCE       = 770993   // Источник (enum)
const ENUM_TELEGRAM      = 998663
const ENUM_MAX           = 998667   // 998665 = tilda, 998667 = max

const DELAY_MS = 250

// ── helpers ───────────────────────────────────────────────────────────────────

async function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)) }

async function amoGet(path: string): Promise<any> {
  const resp = await fetch(`${AMO_BASE}/api/v4${path}`, {
    headers: { Authorization: `Bearer ${AMO_TOKEN}` },
  })
  if (resp.status === 204) return null
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`amoCRM GET ${path} → ${resp.status}: ${text.slice(0, 300)}`)
  }
  return resp.json()
}

function readField(lead: any, fieldId: number): string | null {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.value
  return v !== undefined && v !== null && v !== '' ? String(v) : null
}

function readFieldEnum(lead: any, fieldId: number): number | null {
  const cf: any[] = lead?.custom_fields_values ?? []
  const field = cf.find((f: any) => Number(f.field_id) === fieldId)
  const v = field?.values?.[0]?.enum_id
  return v !== undefined ? Number(v) : null
}

function sourceFromEnum(enumId: number | null): ShipSource {
  if (enumId === ENUM_TELEGRAM) return 'telegram'
  if (enumId === ENUM_MAX) return 'max'
  return 'tilda'
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

// ── main ──────────────────────────────────────────────────────────────────────

async function fetchAllLeads(): Promise<any[]> {
  const leads: any[] = []
  let page = 1
  while (true) {
    console.log(`  Страница ${page}…`)
    const data = await amoGet(
      `/leads?filter[pipeline_id]=${PIPELINE_ID}&with=custom_fields&limit=250&page=${page}`
    )
    const batch: any[] = data?._embedded?.leads ?? []
    if (batch.length === 0) break
    leads.push(...batch)
    if (batch.length < 250) break
    page++
    await sleep(DELAY_MS)
  }
  return leads
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run')
  const limitArg = process.argv.find(a => a.startsWith('--limit='))
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity

  console.log(`Режим: ${isDryRun ? 'DRY RUN (без записи в Sheets)' : 'ЗАПИСЬ В SHEETS'}`)
  console.log(`Лимит лидов: ${isFinite(limit) ? limit : 'все'}`)
  console.log()

  if (!isDryRun) {
    console.log('Проверяем/создаём лист shipment_items…')
    await ensureShipmentItemsSheet()
  }

  console.log('Загружаем лиды из amoCRM…')
  const allLeads = await fetchAllLeads()
  console.log(`Всего лидов: ${allLeads.length}`)
  console.log()

  const leads = isFinite(limit) ? allLeads.slice(0, limit) : allLeads

  let written = 0
  let skipped = 0
  let unknown = 0
  const manualReview: string[] = []

  for (const lead of leads) {
    const stageId: number = lead.status_id
    const status = STAGE_MAP[stageId]

    if (status === 'skip' || status === undefined) {
      skipped++
      continue
    }

    const orderId   = readField(lead, FIELD_ORDER_NUMBER)
    const rawItems  = readField(lead, FIELD_COMPOSITION)
    const sourceEnum = readFieldEnum(lead, FIELD_SOURCE)
    const source     = sourceFromEnum(sourceEnum)
    const orderDate  = lead.created_at ? isoDate(lead.created_at) : ''
    // ship_date: use updated_at for sent/returned stages as a best-effort approximation
    const shipDate = (status === 'sent' || status === 'returned') && lead.updated_at
      ? isoDate(lead.updated_at)
      : ''

    if (!orderId || !rawItems) {
      const note = `lead ${lead.id}: нет orderId или состава`
      manualReview.push(note)
      unknown++
      continue
    }

    const { items, format } = parseAmoCrmComposition(rawItems)

    if (format === 'unknown' || items.length === 0) {
      const note = `lead ${lead.id} (${orderId}): не распознан формат — "${rawItems.slice(0, 80)}"`
      manualReview.push(note)
      unknown++
      continue
    }

    const rows: ShipmentItem[] = items.map(item => ({
      order_id:    orderId,
      source,
      article:     item.article,
      qty:         item.qty,
      order_date:  orderDate,
      ship_status: status,
      ship_date:   shipDate,
    }))

    console.log(`  [${format.toUpperCase()}] ${orderId} [${status}] → ${rows.length} позиц.`)
    rows.forEach(r => console.log(`    article=${r.article} qty=${r.qty}`))

    if (!isDryRun) {
      await appendShipmentItems(rows)
      await sleep(DELAY_MS)
    }
    written += rows.length
  }

  console.log()
  console.log(`Готово. Позиций записано: ${written}, лидов пропущено: ${skipped}, нераспознано: ${unknown}`)

  if (manualReview.length > 0) {
    console.log()
    console.log('=== ПРОВЕРИТЬ ВРУЧНУЮ ===')
    manualReview.forEach(m => console.log(m))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
