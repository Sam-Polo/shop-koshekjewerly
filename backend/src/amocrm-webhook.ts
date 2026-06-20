import type { Request, Response } from 'express'
import pino from 'pino'
import { sendAlert } from './alerts.js'
import { PIPELINE_ID, STAGE_MAP, getAmoBase, getAmoToken, processAmoCrmLead, isTildaPickupInNew, routeLeadToPickupStage } from './amocrm-lead-processor.js'
import { deleteRowsByLeadId } from './shipment-items-sheet.js'

const logger = pino()

async function fetchLead(leadId: number): Promise<any | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(
      `${getAmoBase()}/api/v4/leads/${leadId}?with=custom_fields`,
      { headers: { Authorization: `Bearer ${getAmoToken()}` }, signal: ctrl.signal }
    )
    clearTimeout(timer)
    if (!resp.ok) return null
    return resp.json()
  } catch {
    clearTimeout(timer)
    return null
  }
}

export function handleAmoCrmWebhook(req: Request, res: Response): void {
  const secret = process.env.AMOCRM_WEBHOOK_SECRET
  if (secret && req.query.secret !== secret) {
    res.status(403).json({ error: 'forbidden' })
    return
  }

  res.status(200).json({ ok: true })

  const body: any = req.body

  // Collect leads from both 'status' and 'add' events
  type Entry = { id: number; pipeline_id: number; status_id: number; event: string }
  const queue: Entry[] = []

  for (const l of Object.values(body?.leads?.status ?? {})) {
    queue.push({ id: Number((l as any).id), pipeline_id: Number((l as any).pipeline_id), status_id: Number((l as any).status_id), event: 'status' })
  }
  for (const l of Object.values(body?.leads?.add ?? {})) {
    queue.push({ id: Number((l as any).id), pipeline_id: Number((l as any).pipeline_id), status_id: Number((l as any).status_id), event: 'add' })
  }

  // Handle deleted leads
  const deleteIds: number[] = []
  for (const l of Object.values(body?.leads?.delete ?? {})) {
    deleteIds.push(Number((l as any).id))
  }
  if (deleteIds.length > 0) {
    void (async () => {
      for (const leadId of deleteIds) {
        try {
          const deleted = await deleteRowsByLeadId(String(leadId))
          logger.info({ leadId, deleted }, 'amoCRM webhook: lead deleted from sheet')
          if (deleted > 0) {
            sendAlert(
              `amoCRM: лид ${leadId} удалён → ${deleted} строк удалено из учёта`,
              { tag: 'amocrm', level: 'info', code: 'AMOCRM_LEAD_DELETED' }
            ).catch(() => {})
          }
        } catch (e: any) {
          logger.error({ leadId, err: e?.message }, 'amoCRM webhook: delete from sheet failed')
          sendAlert(
            `amoCRM webhook: не удалось удалить лид ${leadId} из учёта: ${e?.message}`,
            { tag: 'amocrm', level: 'moderate', code: 'AMOCRM_WEBHOOK_DELETE_FAILED' }
          ).catch(() => {})
        }
      }
    })()
  }

  if (queue.length === 0) return

  void (async () => {
    for (const { id: leadId, pipeline_id: pipelineId, status_id: statusId, event } of queue) {
      if (pipelineId !== PIPELINE_ID) continue
      if (!STAGE_MAP[statusId] || STAGE_MAP[statusId] === 'skip') continue

      logger.info({ leadId, statusId, event }, 'amoCRM webhook: received')

      const fullLead = await fetchLead(leadId)
      if (!fullLead) {
        logger.warn({ leadId }, 'amoCRM webhook: failed to fetch lead')
        continue
      }

      try {
        const result = await processAmoCrmLead(fullLead)
        logger.info({ leadId, result, event }, 'amoCRM webhook: done')
      } catch (e: any) {
        logger.error({ leadId, err: e?.message }, 'amoCRM webhook: sheet update failed')
        sendAlert(
          `amoCRM webhook: не удалось обновить учёт для лида ${leadId}: ${e?.message}`,
          { tag: 'amocrm', level: 'moderate', code: 'AMOCRM_WEBHOOK_SHEET_UPDATE_FAILED' }
        ).catch(() => {})
      }

      // Tilda pickup leads land in «Новый» — route them to the САМОВЫВОЗ stage.
      if (isTildaPickupInNew(fullLead)) {
        try {
          await routeLeadToPickupStage(leadId)
          logger.info({ leadId }, 'amoCRM webhook: Tilda pickup lead routed to САМОВЫВОЗ')
        } catch (e: any) {
          logger.error({ leadId, err: e?.message }, 'amoCRM webhook: pickup routing failed')
          sendAlert(
            `amoCRM webhook: не удалось перенести самовывоз-лид ${leadId} в этап САМОВЫВОЗ: ${e?.message}`,
            { tag: 'amocrm', level: 'moderate', code: 'AMOCRM_WEBHOOK_PICKUP_ROUTE_FAILED' }
          ).catch(() => {})
        }
      }
    }
  })()
}
