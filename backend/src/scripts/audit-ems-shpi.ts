/**
 * One-off diagnostic (read-only): сверяет EMS-заказы после 03.07.2026 с тем, что
 * Почта знает по их ШПИ.
 *
 * Контекст: с 03.07 по 04.08.2026 партии создавались с use-online-balance=true,
 * печатные формы не отдавались (403), и на почте отправления, по словам заказчика,
 * оформляли вручную заново. Значит наш ШПИ мог остаться «мёртвым» — покупателю ушёл
 * трек, по которому ничего не едет.
 *
 * Ничего не пишет ни в Sheets, ни в Почту — только чтение.
 *
 * Usage: npx tsx src/scripts/audit-ems-shpi.ts [--since=2026-07-03]
 */
import 'dotenv/config'
import { google } from 'googleapis'
import fs from 'node:fs'
import { pochtaFetch } from '../pochta.js'

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

const sinceArg = process.argv.find(a => a.startsWith('--since='))?.split('=')[1] ?? '2026-07-03'
const sinceMs = new Date(sinceArg).getTime()

// колонки листа orders (см. ORDERS_HEADERS в orders-sheet.ts)
const C = { orderId: 0, createdAt: 1, status: 3, fullName: 7, country: 10, city: 11, deliveryMethod: 25, shpi: 26 }

async function main() {
  const spreadsheetId = process.env.IMPORT_SHEET_ID
  if (!spreadsheetId) throw new Error('IMPORT_SHEET_ID not set')

  const api = google.sheets({ version: 'v4', auth: getAuth() })
  const res = await api.spreadsheets.values.get({ spreadsheetId, range: 'orders!A:AA' })
  const rows = (res.data.values ?? []) as string[][]

  const ems = rows.slice(1).filter(r => {
    if ((r[C.deliveryMethod] ?? '') !== 'ems') return false
    const t = new Date(r[C.createdAt] ?? '').getTime()
    return Number.isFinite(t) && t >= sinceMs
  })

  console.log(`EMS-заказов с ${sinceArg}: ${ems.length}\n`)
  if (!ems.length) return

  for (const r of ems) {
    const orderId = r[C.orderId]
    const shpi = (r[C.shpi] ?? '').trim()
    const head = `${orderId}  ${(r[C.createdAt] ?? '').slice(0, 10)}  ${r[C.status]}  ${r[C.country] || ''} ${r[C.city] || ''}`.trim()

    if (!shpi) {
      console.log(`${head}\n   ⚠️  ШПИ в Sheets пуст — отправление, вероятно, не создалось\n`)
      continue
    }

    // ищем отправление по ШПИ в нашем аккаунте Отправки
    let found = 'не найдено'
    try {
      const resp = await pochtaFetch('GET', `/1.0/shipment/search?query=${encodeURIComponent(shpi)}`) as any
      const list = Array.isArray(resp) ? resp : (resp?.shipments ?? resp?.content ?? [])
      const first = Array.isArray(list) ? list[0] : null
      found = first
        ? JSON.stringify({
            id: first.id ?? first['result-id'],
            barcode: first.barcode,
            status: first['order-status'] ?? first.status,
            batch: first['batch-name'],
          })
        : `пусто (raw: ${JSON.stringify(resp).slice(0, 200)})`
    } catch (e: any) {
      found = 'ERR ' + e?.message?.slice(0, 160)
    }

    console.log(`${head}\n   ШПИ ${shpi}\n   Отправка: ${found}\n`)
    await sleep(400) // не долбим API
  }
}

main().catch(e => { console.error(e); process.exit(1) })
