/**
 * One-off: retry CDEK barcode upload to amoCRM for a SINGLE order.
 *
 * Use when the barcode upload failed for one specific lead (e.g. CDEK was slow
 * generating the PDF and the live poll window expired → AMOCRM_BARCODE_FAILED).
 *
 * Pipeline (reuses the same helpers as the live flow):
 *   1. findLeadByOrderNumber(orderNumber) → lead { id, track, barcode }
 *   2. if barcode already set → nothing to do (idempotent)
 *   3. resolve CDEK order uuid: from --uuid arg, else getCdekUuidByTrack(track)
 *   4. updateAmoCrmLeadBarcode → downloadCdekBarcode (poll) → S3 → set url-field
 *
 * Usage:
 *   npx tsx src/scripts/retry-barcode.ts ORD-1782130764910
 *   npx tsx src/scripts/retry-barcode.ts ORD-1782130764910 --uuid 8cfe2493-65aa-4826-8051-5aa360143f00
 */

import 'dotenv/config'
import { getCdekUuidByTrack, downloadCdekBarcode } from '../cdek.js'
import { findLeadByOrderNumber, updateAmoCrmLeadBarcode } from '../amocrm.js'

async function main() {
  const orderNumber = process.argv[2]
  if (!orderNumber) {
    console.error('Usage: npx tsx src/scripts/retry-barcode.ts <orderNumber> [--uuid <cdekUuid>]')
    process.exit(1)
  }
  const uuidFlagIdx = process.argv.indexOf('--uuid')
  const uuidArg = uuidFlagIdx !== -1 ? process.argv[uuidFlagIdx + 1] : undefined

  console.log(`Ищем лид по номеру заказа ${orderNumber}...`)
  const lead = await findLeadByOrderNumber(orderNumber)
  if (!lead) {
    console.error(`Лид с номером заказа ${orderNumber} не найден в amoCRM`)
    process.exit(1)
  }
  console.log(`Лид ${lead.id}  трек: ${lead.track ?? '—'}  штрихкод: ${lead.barcode ? '✓ уже есть' : '✗ пусто'}`)

  if (lead.barcode) {
    console.log('Штрихкод уже прикреплён — ничего делать не нужно.')
    return
  }

  let uuid = uuidArg
  if (!uuid) {
    if (!lead.track) {
      console.error('В лиде нет трек-номера и не передан --uuid — неоткуда взять CDEK uuid. Прервано.')
      process.exit(1)
    }
    console.log(`Резолвим CDEK uuid по треку ${lead.track}...`)
    uuid = (await getCdekUuidByTrack(lead.track)) ?? undefined
    if (!uuid) {
      console.error(`CDEK не вернул uuid для трека ${lead.track}. Передайте его явно через --uuid.`)
      process.exit(1)
    }
  }
  console.log(`CDEK uuid: ${uuid}`)

  console.log('Качаем штрихкод из CDEK (может занять до ~80с) и заливаем в S3...')
  const url = await updateAmoCrmLeadBarcode(lead.id, uuid, downloadCdekBarcode)
  console.log(`[OK] Штрихкод прикреплён к лиду ${lead.id}: ${url}`)
}

main().catch(e => { console.error('[FAIL]', e?.message ?? e); process.exit(1) })
