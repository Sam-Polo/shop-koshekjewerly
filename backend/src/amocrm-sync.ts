import pino from 'pino'
import { PIPELINE_ID, prepareLeadUpsert, type LeadUpsert } from './amocrm-lead-processor.js'
import { bulkUpsertOrders } from './shipment-items-sheet.js'
import { amoFetch } from './amocrm-client.js'

const logger = pino()

// Ночная страховка — чистый фон: полоса 'low', чтобы синк никогда не задерживал
// создание лида по свежей оплате. Паузы между страницами больше не нужны —
// интервал держит общая очередь (amocrm-client.ts).
const amoGet = (path: string): Promise<any> => amoFetch('GET', path, undefined, 'low')

export type SyncResult = {
  fetched: number
  created: number
  updated: number
  noop: number
  skipped: number
  errors: number
}

/**
 * Fetches all leads in our pipeline updated within the last `hours` hours
 * and upserts each into the shipment_items sheet.
 */
export async function syncRecentAmoCrmLeads(hours = 48): Promise<SyncResult> {
  const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000)
  const result: SyncResult = { fetched: 0, created: 0, updated: 0, noop: 0, skipped: 0, errors: 0 }

  // Phase 1: fetch all pages from amoCRM and build upsert payloads in memory.
  // prepareLeadUpsert does no Sheets I/O, so we never hit the read quota here.
  const preps: LeadUpsert[] = []
  let page = 1
  while (true) {
    const data = await amoGet(
      `/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[updated_at][from]=${since}&with=custom_fields&limit=250&page=${page}`
    )

    const leads: any[] = data?._embedded?.leads ?? []
    if (leads.length === 0) break

    result.fetched += leads.length
    logger.info({ page, count: leads.length }, 'amocrm-sync: fetched page')

    for (const lead of leads) {
      try {
        const prep = prepareLeadUpsert(lead)
        if (prep) preps.push(prep)
        else result.skipped++
      } catch (e: any) {
        logger.error({ leadId: lead.id, err: e?.message }, 'amocrm-sync: error preparing lead')
        result.errors++
      }
    }

    if (leads.length < 250) break
    page++
  }

  // Phase 2: one read + one batchUpdate + one append for the whole sync.
  if (preps.length > 0) {
    try {
      const { created, updated, noop } = await bulkUpsertOrders(preps)
      result.created = created
      result.updated = updated
      result.noop = noop
    } catch (e: any) {
      logger.error({ err: e?.message }, 'amocrm-sync: bulk upsert failed')
      result.errors += preps.length
    }
  }

  logger.info(result, 'amocrm-sync: completed')
  return result
}
