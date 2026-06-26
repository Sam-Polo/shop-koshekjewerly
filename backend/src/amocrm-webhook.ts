import type { Request, Response } from 'express'
import pino from 'pino'
import { sendAlert } from './alerts.js'
import { PIPELINE_ID, STAGE_MAP, getAmoBase, getAmoToken, processAmoCrmLead, isTildaPickupInNew, routeLeadToPickupStage, ENUM_TELEGRAM, FIELD_SOURCE, FIELD_DELIVERY_TYPE, FIELD_ORDER_NUMBER, readField, readFieldEnum } from './amocrm-lead-processor.js'
import { deleteRowsByLeadId } from './shipment-items-sheet.js'
import { getCachedOrdersSettings } from './settings.js'

const logger = pino()

const ASSEMBLED_STATUS_ID = 86486586
const FIELD_TG_CHAT_ID = Number(process.env.AMOCRM_CONTACT_FIELD_TG_ID ?? '770251')
const DEFAULT_ASSEMBLED_MESSAGE =
  '✅ Ваш заказ {{ord}} собран и готов к выдаче!\nЖдём вас по адресу: г. Москва, ул. Горбунова, 2 💗'

async function fetchLeadContactId(leadId: number): Promise<number | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(
      `${getAmoBase()}/api/v4/leads/${leadId}?with=contacts`,
      { headers: { Authorization: `Bearer ${getAmoToken()}` }, signal: ctrl.signal }
    )
    clearTimeout(timer)
    if (!resp.ok) return null
    const data = await resp.json()
    const contacts: any[] = data?._embedded?.contacts ?? []
    const main = contacts.find((c: any) => c.is_main) ?? contacts[0]
    return main ? Number(main.id) : null
  } catch {
    clearTimeout(timer)
    return null
  }
}

async function fetchContactTgChatId(contactId: number): Promise<string | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(
      `${getAmoBase()}/api/v4/contacts/${contactId}?with=custom_fields`,
      { headers: { Authorization: `Bearer ${getAmoToken()}` }, signal: ctrl.signal }
    )
    clearTimeout(timer)
    if (!resp.ok) return null
    const data = await resp.json()
    const cf: any[] = data?.custom_fields_values ?? []
    const field = cf.find((f: any) => Number(f.field_id) === FIELD_TG_CHAT_ID)
    const val = field?.values?.[0]?.value
    return val !== undefined && val !== null && val !== '' ? String(val) : null
  } catch {
    clearTimeout(timer)
    return null
  }
}

async function handleAssembledNotification(fullLead: any): Promise<void> {
  const sourceEnum = readFieldEnum(fullLead, FIELD_SOURCE)
  if (sourceEnum !== ENUM_TELEGRAM) return

  const delivery = (readField(fullLead, FIELD_DELIVERY_TYPE) ?? '').trim().toLowerCase()
  if (!delivery.startsWith('самовывоз')) return

  const leadId = Number(fullLead.id)
  const orderId = readField(fullLead, FIELD_ORDER_NUMBER) ?? `AMO-${leadId}`

  const contactId = await fetchLeadContactId(leadId)
  if (!contactId) {
    logger.info({ leadId }, 'assembled notify: no contact found, skipping')
    return
  }

  const chatId = await fetchContactTgChatId(contactId)
  if (!chatId) {
    logger.info({ leadId, contactId }, 'assembled notify: no TG chat_id in contact, skipping')
    return
  }

  const sheetId = process.env.GOOGLE_SHEET_ID ?? ''
  let template = DEFAULT_ASSEMBLED_MESSAGE
  if (sheetId) {
    const settings = await getCachedOrdersSettings(sheetId)
    if (settings.assembledMessage) template = settings.assembledMessage
  }

  const text = template.replace(/\{\{ord\}\}/g, orderId)

  const token = process.env.TG_BOT_TOKEN
  if (!token) {
    logger.warn({ leadId }, 'assembled notify: TG_BOT_TOKEN not set')
    return
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (resp.ok) {
      logger.info({ leadId, orderId, chatId }, 'assembled notify: message sent')
    } else {
      const err = await resp.text().catch(() => '')
      logger.error({ leadId, chatId, status: resp.status, err }, 'assembled notify: TG error')
      sendAlert(
        `amoCRM assembled: не удалось отправить уведомление (заказ ${orderId}): HTTP ${resp.status} ${err.slice(0, 100)}`,
        { tag: 'amocrm', level: 'moderate', code: 'AMOCRM_ASSEMBLED_TG_ERROR' }
      ).catch(() => {})
    }
  } catch (e: any) {
    clearTimeout(timer)
    logger.error({ leadId, err: e?.message }, 'assembled notify: fetch failed')
    sendAlert(
      `amoCRM assembled: ошибка отправки уведомления (заказ ${orderId}): ${e?.message}`,
      { tag: 'amocrm', level: 'moderate', code: 'AMOCRM_ASSEMBLED_SEND_FAILED' }
    ).catch(() => {})
  }
}

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

      // Notify Telegram customer when lead reaches «Собран» (pickup orders only).
      // Known limitation: webhook may fire multiple times if manager moves stage back and forth.
      if (statusId === ASSEMBLED_STATUS_ID) {
        try {
          await handleAssembledNotification(fullLead)
        } catch (e: any) {
          logger.error({ leadId, err: e?.message }, 'amoCRM webhook: assembled notification failed')
        }
      }
    }
  })()
}
