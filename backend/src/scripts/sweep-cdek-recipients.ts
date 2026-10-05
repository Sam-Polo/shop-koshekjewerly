/**
 * One-off diagnostic (read-only): сверяет получателя по КАЖДОМУ оплаченному CDEK-заказу
 * из Google Sheets с тем, что сейчас реально отдаёт CDEK API по этой отправке.
 * Цель — понять, изолирован ли инцидент с подменой получателя на одном заказе
 * (в CDEK вместо покупателя оказался другой человек) или такое случалось и в
 * других заказах. Номер заказа и имена участников намеренно не указаны: репозиторий
 * публичный, персональные данные покупателей в него попадать не должны.
 *
 * Ничего не пишет ни в Sheets, ни в CDEK — только GET-запросы.
 *
 * Usage: npx tsx src/scripts/sweep-cdek-recipients.ts [--days=60]
 */
import 'dotenv/config'
import { google } from 'googleapis'
import fs from 'node:fs'
import { cdekFetch } from '../cdek.js'

function getAuth() {
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  let creds: any
  if (filePath) creds = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  else if (raw) creds = JSON.parse(raw)
  else throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE is required')
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, ['https://www.googleapis.com/auth/spreadsheets'])
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

// последние 10 цифр — нивелирует разницу форматов +7/8/7XXXXXXXXXX
function normPhone(p: string): string {
  return (p || '').replace(/\D/g, '').slice(-10)
}

function normName(n: string): string {
  return (n || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

async function main() {
  const daysArg = process.argv.find(a => a.startsWith('--days='))
  const days = daysArg ? Number(daysArg.split('=')[1]) : 60
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000

  const spreadsheetId = process.env.IMPORT_SHEET_ID
  if (!spreadsheetId) { console.error('IMPORT_SHEET_ID не задан'); process.exit(1) }

  const auth = getAuth()
  const api = google.sheets({ version: 'v4', auth })
  console.log('Читаем лист orders...')
  const res = await api.spreadsheets.values.get({ spreadsheetId, range: 'orders!A:AB' })
  const rows = res.data.values || []

  // индексы ORDERS_HEADERS (см. orders-sheet.ts): 0=order_id,1=created_at,3=status,
  // 7=full_name,8=phone,23=cdek_uuid,24=cdek_track_number,25=delivery_method
  const candidates: { orderId: string; createdAt: string; fullName: string; phone: string; cdekUuid: string; cdekTrack: string }[] = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[]
    if (!row?.[0]) continue
    const status = row[3] ?? ''
    const deliveryMethod = row[25] ?? ''
    const cdekUuid = row[23] ?? ''
    const cdekTrack = row[24] ?? ''
    const createdAt = row[1] ?? ''
    if (status !== 'paid') continue
    if (deliveryMethod !== 'cdek') continue
    if (!cdekUuid || !cdekTrack) continue
    const createdMs = createdAt ? new Date(createdAt).getTime() : 0
    if (createdMs < sinceMs) continue
    candidates.push({ orderId: row[0], createdAt, fullName: row[7] ?? '', phone: row[8] ?? '', cdekUuid, cdekTrack })
  }

  console.log(`Найдено оплаченных CDEK-заказов за последние ${days} дн.: ${candidates.length}`)
  if (candidates.length === 0) return

  const mismatches: any[] = []
  let checked = 0
  for (const c of candidates) {
    checked++
    process.stdout.write(`[${checked}/${candidates.length}] ${c.orderId} (${c.cdekTrack})... `)
    try {
      const data = await cdekFetch('GET', `/orders/${c.cdekUuid}`) as any
      const entity = data?.entity
      const recipientName = entity?.recipient?.name ?? ''
      const recipientPhone = entity?.recipient?.phones?.[0]?.number ?? ''
      const statuses = entity?.statuses ?? [] // CDEK отдаёт в обратном хронологическом порядке
      const lastStatus = statuses[0]?.name ?? statuses[0]?.code ?? '?'
      const numberField = entity?.number ?? ''

      const phoneMatch = normPhone(recipientPhone) === normPhone(c.phone)
      const numberMatch = numberField === c.orderId

      if (!phoneMatch || !numberMatch) {
        console.log('⚠ MISMATCH')
        mismatches.push({
          orderId: c.orderId, createdAt: c.createdAt, track: c.cdekTrack,
          sheetName: c.fullName, sheetPhone: c.phone,
          cdekName: recipientName, cdekPhone: recipientPhone, cdekNumberField: numberField,
          numberMatch, phoneMatch, lastStatus,
        })
      } else {
        console.log('ok')
      }
    } catch (e: any) {
      console.log(`ERR: ${e?.message}`)
      mismatches.push({ orderId: c.orderId, createdAt: c.createdAt, track: c.cdekTrack, error: e?.message })
    }
    await sleep(350)
  }

  console.log(`\n=== Итог: проверено ${checked}, подозрительных: ${mismatches.length} ===\n`)
  for (const m of mismatches) {
    console.log(JSON.stringify(m, null, 2))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
