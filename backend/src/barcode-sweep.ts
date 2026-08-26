import pino from 'pino'
import { sendAlert } from './alerts.js'
import { amoFetch } from './amocrm-client.js'
import { syncCdekToLead } from './amocrm.js'
import { getCdekUuidByTrack, downloadCdekBarcode } from './cdek.js'
import { PIPELINE_ID } from './amocrm-lead-processor.js'

const logger = pino()

// ── Страховка: лиды с треком, но без штрихкода ───────────────────────────────
//
// Штрихкод — единственное, что нужно менеджеру, чтобы физически отправить
// посылку. Заполняется он ровно один раз: для наших заказов — в processPaidOrder,
// для тильдиных — по вебхуку СДЭКа. Если эта единственная попытка не сработала,
// второго шанса нет: посылка стоит в CREATED и новых событий не породит, пока её
// не отправят, а отправить нельзя без штрихкода — замкнутый круг.
//
// У синка лидов такая страховка есть (ночной delta-sync), у штрихкодов не было.
// Этот свип её добавляет: ищет лиды с треком и без штрихкода и дозаполняет их
// тем же боевым syncCdekToLead (идемпотентен, трогает только пустые поля).

const FIELD_TRACK = Number(process.env.AMOCRM_FIELD_CDEK_TRACK_ID) || 774619
const FIELD_BARCODE = Number(process.env.AMOCRM_FIELD_BARCODE_ID) || 771975
const FIELD_ORDER = Number(process.env.AMOCRM_FIELD_ORDER_NUMBER_ID) || 774543

export type BarcodeSweepResult = {
  scanned: number
  broken: number
  filled: number
  failed: number
  skipped: number
}

function readField(lead: any, fieldId: number): string | null {
  const f = (lead?.custom_fields_values ?? []).find((x: any) => Number(x.field_id) === fieldId)
  const v = f?.values?.[0]?.value
  return v !== undefined && v !== null && v !== '' ? String(v) : null
}

/**
 * Ищет лиды с треком и без штрихкода за последние `days` дней и дозаполняет их.
 * `limit` бережёт время ночного прогона: штатно битых лидов единицы, а если их
 * вдруг десятки — значит сломан вебхук, и это чинится не свипом.
 * Никогда не бросает.
 */
export async function sweepMissingBarcodes(days = 14, limit = 25): Promise<BarcodeSweepResult> {
  const result: BarcodeSweepResult = { scanned: 0, broken: 0, filled: 0, failed: 0, skipped: 0 }
  const since = Math.floor((Date.now() - days * 86400_000) / 1000)

  const leads: any[] = []
  let page = 1
  try {
    for (;;) {
      const data = await amoFetch('GET',
        `/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[created_at][from]=${since}` +
        `&order[created_at]=asc&limit=250&page=${page}&with=custom_fields`, undefined, 'low') as any
      const batch: any[] = data?._embedded?.leads ?? []
      if (batch.length === 0) break
      leads.push(...batch)
      if (batch.length < 250) break
      page++
    }
  } catch (e: any) {
    logger.error({ err: e?.message }, 'barcode-sweep: не удалось прочитать лиды')
    return result
  }

  result.scanned = leads.length
  const broken = leads.filter(l => readField(l, FIELD_TRACK) && !readField(l, FIELD_BARCODE))
  result.broken = broken.length
  if (broken.length === 0) {
    logger.info(result, 'barcode-sweep: всё на месте')
    return result
  }

  for (const lead of broken.slice(0, limit)) {
    const track = readField(lead, FIELD_TRACK)!
    const orderNumber = readField(lead, FIELD_ORDER)
    if (!orderNumber) { result.skipped++; continue }
    try {
      const uuid = await getCdekUuidByTrack(track)
      if (!uuid) { result.skipped++; continue }
      const res = await syncCdekToLead(orderNumber, track, uuid, downloadCdekBarcode)
      if (res.matched && res.action === 'updated') result.filled++
      else result.skipped++
    } catch (e: any) {
      result.failed++
      logger.warn({ orderNumber, track, err: e?.message }, 'barcode-sweep: не удалось дозаполнить')
    }
  }

  logger.info(result, 'barcode-sweep: завершён')

  // Свип что-то залатал — значит штатный путь (вебхук СДЭКа) не сработал.
  // Это не «всё хорошо, страховка отработала», а сигнал, что где-то течёт.
  if (result.filled > 0) {
    sendAlert(
      `Штрихкоды: страховочный свип дозаполнил ${result.filled} лид(ов) из ${result.broken} найденных. ` +
      `Значит штатный путь не сработал.`,
      {
        tag: 'cdek',
        level: 'moderate',
        hint: 'проверьте подписку на вебхуки СДЭК: npx tsx src/scripts/register-cdek-webhook.ts list',
        code: 'CDEK_BARCODE_SWEEP_FILLED',
      }
    ).catch(() => {})
  }
  if (result.failed > 0) {
    sendAlert(
      `Штрихкоды: свип не смог дозаполнить ${result.failed} лид(ов) — менеджер не сможет отправить эти посылки.`,
      { tag: 'cdek', level: 'high', hint: 'разберите вручную: src/scripts/retry-barcode.ts <номер заказа>', code: 'CDEK_BARCODE_SWEEP_FAILED' }
    ).catch(() => {})
  }

  return result
}
