/**
 * One-off script: fill missing comments in Tilda leads from a Telegram chat export.
 *
 * Source: Tilda bot Telegram chat export (tilda-tg-messages.json).
 * Target: amoCRM leads with tag "импорт_13062026_0407".
 * Match:  by order number (field AMOCRM_FIELD_ORDER_NUMBER_ID = 774543).
 * Fill:   comment field (AMOCRM_FIELD_COMMENT_ID = 774809) — only if currently empty.
 *
 * Usage:
 *   npx tsx src/scripts/fill-tilda-comments.ts <path-to-tilda-tg-messages.json> [--dry-run]
 *
 * --dry-run: show what would be patched without touching amoCRM.
 */

import 'dotenv/config'
import fs from 'node:fs'

const AMO_BASE  = `https://${process.env.AMOCRM_SUBDOMAIN}.amocrm.ru`
const AMO_TOKEN = process.env.AMOCRM_ACCESS_TOKEN!

const TILDA_LEAD_NAME = 'Тильда импорт'
const TARGET_TAG      = 'импорт_13062026_0407'
const DELAY_MS        = 400

const F = {
  orderNumber: Number(process.env.AMOCRM_FIELD_ORDER_NUMBER_ID),
  comment:     Number(process.env.AMOCRM_FIELD_COMMENT_ID),
}

// ── amoCRM helpers ────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

function getFieldValue(lead: any, fieldId: number): string | null {
  const f = (lead.custom_fields_values ?? []).find((f: any) => f.field_id === fieldId)
  return f?.values?.[0]?.value ?? null
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
    method:  'PATCH',
    headers: { Authorization: `Bearer ${AMO_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`amoCRM PATCH ${path} → ${resp.status}: ${text.slice(0, 300)}`)
  }
}

// Fetch all "Тильда импорт" leads that carry TARGET_TAG, with custom_fields and tags.
async function fetchTargetLeads(): Promise<any[]> {
  const all: any[] = []
  let page = 1

  while (true) {
    await sleep(DELAY_MS)
    const data = await amoGet(
      `/leads?query=${encodeURIComponent(TILDA_LEAD_NAME)}&limit=250&page=${page}&with=custom_fields,tags`
    )
    const leads: any[] = data?._embedded?.leads ?? []
    if (leads.length === 0) break

    const matched = leads.filter((l: any) => {
      if (l.name !== TILDA_LEAD_NAME) return false
      const tags: any[] = l._embedded?.tags ?? []
      return tags.some((t: any) => t.name === TARGET_TAG)
    })
    all.push(...matched)

    if (leads.length < 250) break
    page++
  }
  return all
}

// ── TG message parser ─────────────────────────────────────────────────────────

// Flatten Telegram's mixed text-array (strings + {type,text} objects) to a plain string.
function flattenText(textField: unknown): string {
  if (typeof textField === 'string') return textField
  if (!Array.isArray(textField)) return ''
  return textField.map(seg => (typeof seg === 'string' ? seg : (seg as any)?.text ?? '')).join('')
}

// Build orderNumber → comment map from the exported JSON.
function parseComments(jsonPath: string): Map<string, string> {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  const messages: any[] = data.messages ?? []
  const map = new Map<string, string>()

  for (const msg of messages) {
    if (msg.type !== 'message') continue

    const flat = flattenText(msg.text)

    // Order number sits right after "Заказ №"
    const orderMatch = flat.match(/Заказ №(\d+)/)
    if (!orderMatch) continue
    const orderNumber = orderMatch[1]

    // Comment field label is lowercase "comment:" (Tilda default) or uppercase "Комментарий:".
    // It ends at the next field label or the separator line.
    const commentMatch = flat.match(
      /\n(?:comment|Комментарий):\s*([\s\S]+?)(?:\nName:|\nma_name:|\nma_email:|\n-----|\nCheckbox:)/i
    )
    if (!commentMatch) continue

    const comment = commentMatch[1].trim()
    if (!comment) continue

    if (map.has(orderNumber)) {
      console.warn(`[WARN] Дублирующийся номер заказа в TG: ${orderNumber} — оставляем первое вхождение`)
    } else {
      map.set(orderNumber, comment)
    }
  }

  return map
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const jsonPath = process.argv[2]
  const dryRun   = process.argv.includes('--dry-run')

  if (!jsonPath) {
    console.error('Usage: npx tsx src/scripts/fill-tilda-comments.ts <tilda-tg-messages.json> [--dry-run]')
    process.exit(1)
  }
  if (!fs.existsSync(jsonPath)) {
    console.error(`Файл не найден: ${jsonPath}`)
    process.exit(1)
  }
  if (!F.orderNumber) { console.error('AMOCRM_FIELD_ORDER_NUMBER_ID не задан'); process.exit(1) }
  if (!F.comment)     { console.error('AMOCRM_FIELD_COMMENT_ID не задан');      process.exit(1) }

  if (dryRun) console.log('[DRY RUN] amoCRM не будет изменён\n')

  // 1. Parse TG export
  console.log(`Парсим TG-сообщения из ${jsonPath}...`)
  const commentMap = parseComments(jsonPath)
  console.log(`Найдено заказов с комментарием: ${commentMap.size}`)

  // 2. Fetch amoCRM leads
  console.log(`\nЗагружаем лиды "${TILDA_LEAD_NAME}" с тегом "${TARGET_TAG}"...`)
  const leads = await fetchTargetLeads()
  console.log(`Найдено лидов: ${leads.length}\n`)

  if (leads.length === 0) {
    console.log('Нечего обрабатывать.')
    return
  }

  // 3. Patch
  let updated = 0, skipped = 0, noMatch = 0, errors = 0
  const errorLog: string[] = []

  for (const lead of leads) {
    const orderNumber = getFieldValue(lead, F.orderNumber)
    if (!orderNumber) {
      console.log(`[SKIP] лид ${lead.id} — нет номера заказа в поле ${F.orderNumber}`)
      noMatch++
      continue
    }

    const comment = commentMap.get(orderNumber)
    if (!comment) {
      console.log(`[NOMATCH] лид ${lead.id}, заказ №${orderNumber} — комментария нет в TG-экспорте`)
      noMatch++
      continue
    }

    const existing = getFieldValue(lead, F.comment)
    if (existing) {
      console.log(`[SKIP] лид ${lead.id}, заказ №${orderNumber} — комментарий уже есть: "${existing.slice(0, 80)}"`)
      skipped++
      continue
    }

    const preview = comment.slice(0, 80).replace(/\n/g, ' ')
    if (dryRun) {
      console.log(`[DRY] лид ${lead.id}, заказ №${orderNumber} ← "${preview}"`)
      updated++
      continue
    }

    try {
      await sleep(DELAY_MS)
      await amoPatch(`/leads/${lead.id}`, {
        custom_fields_values: [{ field_id: F.comment, values: [{ value: comment }] }],
      })
      console.log(`[OK] лид ${lead.id}, заказ №${orderNumber} ← "${preview}"`)
      updated++
    } catch (e: any) {
      const msg = `[ERR] лид ${lead.id}, заказ №${orderNumber}: ${e?.message}`
      console.error(msg)
      errorLog.push(msg)
      errors++
    }
  }

  const action = dryRun ? 'Обновлено бы' : 'Обновлено'
  console.log(`\nГотово. ${action}: ${updated}, пропущено (уже есть): ${skipped}, нет совпадения: ${noMatch}, ошибок: ${errors}`)
  if (errorLog.length > 0) {
    console.log('\nОшибки:')
    errorLog.forEach(m => console.log(m))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
