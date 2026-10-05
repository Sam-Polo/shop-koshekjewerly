/**
 * One-off diagnostic (read-only): investigate CDEK track-number mismatch incident.
 * Usage: npx tsx src/scripts/investigate-cdek-order.ts
 */
import 'dotenv/config'
import { cdekFetch, getCdekUuidByTrack } from '../cdek.js'

const OUR_UUID = '146492a0-b5b8-47c5-8081-6bccc8bd7b0c'
const TRACK_NUMBER = '10290403516'

async function main() {
  console.log('=== 1) GET /orders/{our_uuid} — что CDEK знает по НАШЕЙ сущности заказа ===')
  try {
    const byUuid = await cdekFetch('GET', `/orders/${OUR_UUID}`) as any
    console.log(JSON.stringify(byUuid, null, 2))
  } catch (e: any) {
    console.error('Ошибка запроса по uuid:', e?.message)
  }

  console.log('\n=== 2) GET /orders?cdek_number=... — какой uuid CDEK СЕЙЧАС связывает с этим трек-номером ===')
  try {
    const byTrack = await cdekFetch('GET', `/orders?cdek_number=${encodeURIComponent(TRACK_NUMBER)}`) as any
    console.log(JSON.stringify(byTrack, null, 2))
  } catch (e: any) {
    console.error('Ошибка запроса по track number:', e?.message)
  }

  console.log('\n=== 3) getCdekUuidByTrack helper (как используется в проде) ===')
  try {
    const uuid = await getCdekUuidByTrack(TRACK_NUMBER)
    console.log('uuid по треку:', uuid, uuid === OUR_UUID ? '(СОВПАДАЕТ с нашим)' : '(!!! НЕ СОВПАДАЕТ с нашим uuid ' + OUR_UUID + ')')
  } catch (e: any) {
    console.error('Ошибка getCdekUuidByTrack:', e?.message)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
