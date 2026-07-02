/**
 * Точечная очистка дублей в shipment_items: наследие старого бага tilda-вебхука,
 * когда заказ записывался дважды (вебхук + импорт) до фикса дедупликации.
 *
 * Правило: группируем строки по order_id+article. В группе из 2 строк с одинаковым qty
 * оставляем одну (приоритет: строка с lead_id → строка с непустым/не-pending статусом → первая),
 * вторую удаляем. Группы из 3+ строк или с разным qty НЕ трогаем — выводим на ручной разбор.
 *
 * Usage:
 *   npx tsx src/scripts/cleanup-duplicate-items.ts            # dry-run: только показать план
 *   npx tsx src/scripts/cleanup-duplicate-items.ts --apply    # реально удалить строки
 */
import 'dotenv/config'
import { google } from 'googleapis'
import fs from 'node:fs'

const SHEET_NAME = 'shipment_items'
const isApply = process.argv.includes('--apply')

function getAuth() {
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  let creds: any
  if (filePath) creds = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  else if (raw) creds = JSON.parse(raw)
  else throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE required')
  return new google.auth.JWT(
    creds.client_email, undefined, creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  )
}

function fmt(r: any[], rowNum: number): string {
  return `row ${rowNum}: order=${r[0]} src=${r[1]} art=${r[2]} qty=${r[3]} date=${r[4]} status=${r[5]} ship=${r[6] ?? ''} lead=${r[8] ?? ''}`
}

async function main() {
  console.log(`Режим: ${isApply ? 'УДАЛЕНИЕ' : 'DRY RUN (только план)'}`)
  console.log()

  const sheets = google.sheets({ version: 'v4', auth: getAuth() })
  const spreadsheetId = process.env.IMPORT_SHEET_ID!

  const meta = await sheets.spreadsheets.get({ spreadsheetId })
  const sheetMeta = meta.data.sheets?.find(s => s.properties?.title === SHEET_NAME)
  if (!sheetMeta) throw new Error(`Лист ${SHEET_NAME} не найден`)
  const sheetId = sheetMeta.properties?.sheetId ?? 0

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_NAME}!A:I`,
  })
  const rows = res.data.values ?? []

  // группируем по order_id|article (0-based индексы строк листа)
  const groups = new Map<string, { r: any[]; idx: number }[]>()
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue
    const key = `${rows[i][0]}|${rows[i][2]}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push({ r: rows[i], idx: i })
  }

  const toDelete: { r: any[]; idx: number }[] = []
  const manual: string[] = []

  for (const [key, g] of groups) {
    if (g.length < 2) continue

    const qtys = new Set(g.map(({ r }) => String(r[3] ?? '')))
    if (g.length > 2 || qtys.size > 1) {
      manual.push(`${key} × ${g.length}${qtys.size > 1 ? ' (разные qty!)' : ''}`)
      g.forEach(({ r, idx }) => manual.push(`  ${fmt(r, idx + 1)}`))
      continue
    }

    // выбираем какую строку ОСТАВИТЬ
    const [a, b] = g
    const score = ({ r }: { r: any[] }) =>
      (r[8] ? 2 : 0) +                                   // есть lead_id — источник amo, авторитетнее
      (r[5] && r[5] !== 'pending' ? 1 : 0)               // статус двигался — строка живая
    const keep = score(b) > score(a) ? b : a
    const del  = keep === a ? b : a

    console.log(`── ${key}`)
    console.log(`   KEEP   ${fmt(keep.r, keep.idx + 1)}`)
    console.log(`   DELETE ${fmt(del.r, del.idx + 1)}`)
    toDelete.push(del)
  }

  console.log()
  console.log(`Итого: групп-дублей к очистке ${toDelete.length}, на ручной разбор ${manual.length > 0 ? '⚠' : ''} ${manual.filter(m => !m.startsWith('  ')).length}`)

  if (manual.length > 0) {
    console.log()
    console.log('=== РУЧНОЙ РАЗБОР (не трогаем) ===')
    manual.forEach(m => console.log(m))
  }

  if (!isApply || toDelete.length === 0) {
    if (!isApply) console.log('\nDry-run завершён. Для удаления: npx tsx src/scripts/cleanup-duplicate-items.ts --apply')
    return
  }

  // удаляем снизу вверх, чтобы индексы не съезжали
  toDelete.sort((x, y) => y.idx - x.idx)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: toDelete.map(({ idx }) => ({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
        },
      })),
    },
  })
  console.log(`\nУдалено строк: ${toDelete.length}`)
}

main().catch(e => { console.error(e); process.exit(1) })
