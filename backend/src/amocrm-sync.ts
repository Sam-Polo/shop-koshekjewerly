import pino from 'pino'
import { PIPELINE_ID, getAmoBase, getAmoToken, processAmoCrmLead } from './amocrm-lead-processor.js'

const logger = pino()

async function amoGet(path: string): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(`${getAmoBase()}/api/v4${path}`, {
      headers: { Authorization: `Bearer ${getAmoToken()}` },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (resp.status === 204) return null
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`amoCRM GET ${path} → ${resp.status}: ${text.slice(0, 200)}`)
    }
    return resp.json()
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

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

  let page = 1
  while (true) {
    const data = await amoGet(
      `/leads?filter[pipeline_id]=${PIPELINE_ID}&filter[updated_at][from]=${since}&with=custom_fields&limit=250&page=${page}`
    )

    const leads: any[] = data?._embedded?.leads ?? []
    if (leads.length === 0) break

    result.fetched += leads.length
    logger.info({ page, count: leads.length }, 'amocrm-sync: processing page')

    for (const lead of leads) {
      try {
        const r = await processAmoCrmLead(lead)
        if (r === 'created')       result.created++
        else if (r === 'updated')  result.updated++
        else if (r === 'noop')     result.noop++
        else                       result.skipped++
      } catch (e: any) {
        logger.error({ leadId: lead.id, err: e?.message }, 'amocrm-sync: error processing lead')
        result.errors++
      }
    }

    if (leads.length < 250) break
    page++
    // small delay between pages to avoid amoCRM rate limiting
    await new Promise<void>(r => setTimeout(r, 300))
  }

  logger.info(result, 'amocrm-sync: completed')
  return result
}
