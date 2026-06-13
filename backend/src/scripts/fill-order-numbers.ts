/**
 * One-off script: fill missing order numbers in Tilda leads from a CSV mapping.
 *
 * Approach: load ALL "Тильда импорт" leads upfront, build an in-memory index
 * by CDEK track number, then match against the CSV. This avoids relying on
 * amoCRM query search which does not reliably index numeric custom field values.
 *
 * Safety guards:
 *   - Only touches leads named "Тильда импорт"
 *   - Skips leads that already have an order number filled
 *
 * Usage:
 *   npx tsx src/scripts/fill-order-numbers.ts <mapping.csv>
 *
 * CSV format (comma or semicolon, any number of columns, header row required):
 *   must contain columns named exactly "Track number" and "Номер заказа"
 */

import 'dotenv/config'
import fs from 'node:fs'

const AMO_BASE = `https://${process.env.AMOCRM_SUBDOMAIN}.amocrm.ru`
const AMO_TOKEN = process.env.AMOCRM_ACCESS_TOKEN!
const ORDER_NUMBER_FIELD_ID = Number(process.env.AMOCRM_FIELD_ORDER_NUMBER_ID)
const CDEK_TRACK_FIELD_ID   = Number(process.env.AMOCRM_FIELD_CDEK_TRACK_ID)
const TILDA_LEAD_NAME = 'Тильда импорт'
const DELAY_MS = 350

async function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

async function amoGet(path: string): Promise<any> {
  const resp = await fetch(`${AMO_BASE}/api/v4${path}`, {
    headers: { Authorization: `Bearer ${AMO_TOKEN}` },
  })
  if (resp.status === 204) return null
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`amoCRM GET ${path} → ${resp.status}: ${text.slice(0, 200)}`)
  }
  return resp.json()
}

async function amoPatch(path: string, body: unknown): Promise<void> {
  const resp = await fetch(`${AMO_BASE}/api/v4${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AMO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`amoCRM PATCH ${path} → ${resp.status}: ${text.slice(0, 300)}`)
  }
}

function getFieldValue(lead: any, fieldId: number): string | null {
  const f = (lead.custom_fields_values ?? []).find((f: any) => f.field_id === fieldId)
  return f?.values?.[0]?.value ?? null
}

async function fetchAllTildaLeads(): Promise<any[]> {
  const all: any[] = []
  let page = 1
  while (true) {
    await sleep(DELAY_MS)
    const data = await amoGet(
      `/leads?query=${encodeURIComponent(TILDA_LEAD_NAME)}&limit=250&page=${page}&with=custom_fields`
    )
    const leads: any[] = data?._embedded?.leads ?? []
    if (leads.length === 0) break
    all.push(...leads.filter((l: any) => l.name === TILDA_LEAD_NAME))
    if (leads.length < 250) break
    page++
  }
  return all
}

function parseCSV(content: string): Array<[string, string]> {
  const lines = content.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return []
  const delim = lines[0].includes(';') ? ';' : ','
  const parse = (l: string) => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ''))

  const header = parse(lines[0]).map(h => h.toLowerCase())
  const trackCol = header.findIndex(h => h === 'track number')
  const orderCol = header.findIndex(h => h === 'номер заказа')

  if (trackCol === -1) throw new Error('Колонка "Track number" не найдена в заголовке CSV')
  if (orderCol === -1) throw new Error('Колонка "Номер заказа" не найдена в заголовке CSV')

  return lines.slice(1)
    .map(parse)
    .filter(r => r[trackCol] && r[orderCol])
    .map(r => [r[trackCol], r[orderCol]])
}

async function main() {
  const csvPath = process.argv[2]
  if (!csvPath) {
    console.error('Usage: npx tsx src/scripts/fill-order-numbers.ts <mapping.csv>')
    console.error('CSV должен содержать колонки "Track number" и "Номер заказа"')
    process.exit(1)
  }
  if (!fs.existsSync(csvPath)) {
    console.error(`Файл не найден: ${csvPath}`)
    process.exit(1)
  }
  if (!ORDER_NUMBER_FIELD_ID) { console.error('AMOCRM_FIELD_ORDER_NUMBER_ID не задан'); process.exit(1) }
  if (!CDEK_TRACK_FIELD_ID)   { console.error('AMOCRM_FIELD_CDEK_TRACK_ID не задан');   process.exit(1) }

  const pairs = parseCSV(fs.readFileSync(csvPath, 'utf8'))
  console.log(`CSV загружен: ${pairs.length} строк`)

  const debugTrack = process.argv[3] === '--debug' ? process.argv[4] : null

  console.log(`\nЗагружаем все лиды "${TILDA_LEAD_NAME}" из amoCRM...`)
  const tildaLeads = await fetchAllTildaLeads()
  console.log(`Найдено тильдовских лидов: ${tildaLeads.length}`)

  // build index: track_number → lead (warn on duplicates)
  const byTrack = new Map<string, any>()
  for (const lead of tildaLeads) {
    const track = getFieldValue(lead, CDEK_TRACK_FIELD_ID)
    if (!track) continue
    if (byTrack.has(track)) {
      console.warn(`[WARN] дублирующийся трек ${track}: лиды ${byTrack.get(track).id} и ${lead.id}`)
    } else {
      byTrack.set(track, lead)
    }
  }
  console.log(`Лидов с треком: ${byTrack.size}\n`)

  if (debugTrack) {
    console.log(`[DEBUG] Конфигурация:`)
    console.log(`  ORDER_NUMBER_FIELD_ID = ${ORDER_NUMBER_FIELD_ID}  (env: ${process.env.AMOCRM_FIELD_ORDER_NUMBER_ID})`)
    console.log(`  CDEK_TRACK_FIELD_ID   = ${CDEK_TRACK_FIELD_ID}   (env: ${process.env.AMOCRM_FIELD_CDEK_TRACK_ID})`)

    const lead = byTrack.get(debugTrack)
    if (!lead) {
      console.log(`[DEBUG] Трек ${debugTrack} не найден в индексе тильдовских лидов`)
    } else {
      const existingVal = getFieldValue(lead, ORDER_NUMBER_FIELD_ID)
      console.log(`[DEBUG] Лид ${lead.id} для трека ${debugTrack}:`)
      console.log(`  name: "${lead.name}"`)
      console.log(`  getFieldValue(${ORDER_NUMBER_FIELD_ID}) = ${JSON.stringify(existingVal)}  → ${existingVal ? 'SKIP (уже заполнено)' : 'PATCH (пустое)'}`)
      console.log(`  custom_fields_values:`)
      for (const f of lead.custom_fields_values ?? []) {
        const marker = f.field_id === ORDER_NUMBER_FIELD_ID ? ' ← ORDER_NUMBER' : f.field_id === CDEK_TRACK_FIELD_ID ? ' ← CDEK_TRACK' : ''
        console.log(`    field_id=${f.field_id}  value=${JSON.stringify(f.values?.[0]?.value)}${marker}`)
      }
    }
    return
  }

  let updated = 0, skipped = 0, warnings = 0
  const warnLog: string[] = []

  for (const [track, orderId] of pairs) {
    const lead = byTrack.get(track)

    if (!lead) {
      const msg = `[WARN] ${track} → лид не найден среди тильдовских`
      console.warn(msg)
      warnLog.push(msg)
      warnings++
      continue
    }

    const existing = getFieldValue(lead, ORDER_NUMBER_FIELD_ID)
    if (existing) {
      console.log(`[SKIP] ${track} → лид ${lead.id} уже имеет номер заказа "${existing}"`)
      skipped++
      continue
    }

    try {
      await sleep(DELAY_MS)
      await amoPatch(`/leads/${lead.id}`, {
        custom_fields_values: [{ field_id: ORDER_NUMBER_FIELD_ID, values: [{ value: orderId }] }],
      })
      console.log(`[OK] ${track} → лид ${lead.id} ← ${orderId}`)
      updated++
    } catch (e: any) {
      const msg = `[ERR] ${track} → лид ${lead.id}: ${e?.message}`
      console.error(msg)
      warnLog.push(msg)
      warnings++
    }
  }

  console.log(`\nГотово. Обновлено: ${updated}, пропущено: ${skipped}, предупреждений/ошибок: ${warnings}`)
  if (warnLog.length > 0) {
    console.log('\nСписок предупреждений и ошибок:')
    warnLog.forEach(m => console.log(m))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
