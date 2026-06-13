/**
 * One-off script: fill missing order numbers in Tilda leads from a CSV mapping.
 *
 * Tilda leads were imported without order numbers. This script reads a CSV with
 * (track_number → order_number) pairs and patches the amoCRM lead found by that track.
 *
 * Safety guards:
 *   - Only touches leads named "Тильда импорт" (skips bot leads and any other)
 *   - Skips leads that already have an order number filled (non-Tilda may appear in search)
 *   - Warns and skips if query returns 2+ leads for one track (ambiguous)
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
  if (!resp.ok) return null
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
  if (!ORDER_NUMBER_FIELD_ID) {
    console.error('AMOCRM_FIELD_ORDER_NUMBER_ID не задан')
    process.exit(1)
  }

  const pairs = parseCSV(fs.readFileSync(csvPath, 'utf8'))
  console.log(`CSV загружен: ${pairs.length} строк`)

  let updated = 0, skipped = 0, warnings = 0
  const warnLog: string[] = []

  for (const [track, orderId] of pairs) {
    await sleep(DELAY_MS)

    let data: any
    try {
      data = await amoGet(`/leads?query=${encodeURIComponent(track)}&limit=5&with=custom_fields`)
    } catch (e: any) {
      const msg = `[ERR] ${track}: ошибка запроса — ${e?.message}`
      console.error(msg)
      warnLog.push(msg)
      warnings++
      continue
    }

    const leads: any[] = data?._embedded?.leads ?? []

    if (leads.length === 0) {
      const msg = `[WARN] ${track} → лид не найден`
      console.warn(msg)
      warnLog.push(msg)
      warnings++
      continue
    }

    if (leads.length > 1) {
      const ids = leads.map((l: any) => l.id).join(', ')
      const msg = `[WARN] ${track} → найдено ${leads.length} лидов (${ids}), пропускаем`
      console.warn(msg)
      warnLog.push(msg)
      warnings++
      continue
    }

    const lead = leads[0]

    if (lead.name !== TILDA_LEAD_NAME) {
      console.log(`[SKIP] ${track} → лид ${lead.id} не тильдовский (name="${lead.name}")`)
      skipped++
      continue
    }

    const existing = lead.custom_fields_values
      ?.find((f: any) => f.field_id === ORDER_NUMBER_FIELD_ID)
      ?.values?.[0]?.value

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
