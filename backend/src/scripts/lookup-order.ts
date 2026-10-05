/**
 * One-off diagnostic (read-only): состояние конкретного заказа в Sheets + у Почты по ШПИ.
 * Usage: npx tsx src/scripts/lookup-order.ts ORD-xxxxxxxxxxxxx
 */
import 'dotenv/config'
import { google } from 'googleapis'
import fs from 'node:fs'
import { pochtaFetch } from '../pochta.js'

const ORDER_ID = process.argv[2]
if (!ORDER_ID) { console.error('usage: lookup-order.ts ORD-xxxxxxxxxxxxx'); process.exit(1) }

function getAuth() {
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  const creds = filePath ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : JSON.parse(raw!)
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, ['https://www.googleapis.com/auth/spreadsheets'])
}

async function main() {
  const api = google.sheets({ version: 'v4', auth: getAuth() })
  const res = await api.spreadsheets.values.get({ spreadsheetId: process.env.IMPORT_SHEET_ID, range: 'orders!A:AA' })
  const rows = res.data.values ?? []
  const row = rows.find(r => r[0] === ORDER_ID)
  if (!row) { console.log('заказ не найден в Sheets'); return }

  console.log('=== Sheets ===')
  console.log('order_id:', row[0], '| created_at:', row[1], '| status:', row[3])
  console.log('full_name:', row[7], '| country/city:', row[10], '/', row[11])
  console.log('delivery_method:', row[25], '| pochta_shpi:', row[26])
  console.log('admin_note:', row[22])

  const shpi = row[26]
  if (!shpi) { console.log('\nШПИ пуст — у Почты искать нечего'); return }

  console.log('\n=== Почта: /1.0/shipment/search ===')
  try {
    const list = await pochtaFetch('GET', `/1.0/shipment/search?query=${shpi}`) as any[]
    const d = list?.[0]
    if (!d) { console.log('не найдено'); return }
    console.log(JSON.stringify({
      id: d.id, orderNum: d['order-num'], batch: d['batch-name'], batchStatus: d['batch-status'],
      mailType: d['mail-type'], mailCategory: d['mail-category'], paymentMethod: d['payment-method'],
      dateCreated: d['batch-status-date'],
    }, null, 1))
  } catch (e: any) {
    console.log('ошибка запроса:', e?.message)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
