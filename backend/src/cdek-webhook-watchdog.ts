import pino from 'pino'
import { sendAlert } from './alerts.js'
import { cdekFetch } from './cdek.js'

const logger = pino()

// ── Сторож подписки на вебхуки СДЭК ──────────────────────────────────────────
//
// Вебхук СДЭКа — единственный триггер сразу трёх вещей: уведомления покупателю
// об отправке, статуса заказа в ЛК и дозаполнения трек-ссылки/штрихкода в
// тильдиных лидах. Если подписка пропадает, всё это умирает МОЛЧА: нет вебхука
// — не запускается обработчик — некому алертить.
//
// История: 25.08.2026 подписка исчезла впервые, заметили через двое суток и
// случайно. 26.08 восстановили руками — и она пропала СНОВА в течение шести
// часов. То есть это не разовый сбой, а повторяющийся: скорее всего СДЭК сам
// снимает подписку после серии неудачных доставок, а доставки не удаются,
// потому что Render на free-tier засыпает и холодный старт занимает ~20 с —
// дольше, чем СДЭК готов ждать ответа.
//
// Поэтому сторож не просто наблюдает, а ВОССТАНАВЛИВАЕТ подписку сам: пока
// первопричина (засыпание Render) не устранена, ручное восстановление означает
// часы неработающих уведомлений между проверками.

function backendBase(): string {
  return (process.env.BACKEND_URL ?? 'https://shop-koshekjewerly.onrender.com').replace(/\/$/, '')
}

/** URL подписки = наш эндпоинт + токен, если он задан. Единственный источник истины. */
export function cdekWebhookUrl(): string {
  const secret = process.env.CDEK_WEBHOOK_SECRET
  return `${backendBase()}/api/cdek/webhook${secret ? `?token=${encodeURIComponent(secret)}` : ''}`
}

export async function listCdekWebhooks(): Promise<any[]> {
  const data = await cdekFetch('GET', '/webhooks')
  return Array.isArray(data) ? data : ((data as any)?.entity ?? [])
}

export async function registerCdekWebhook(): Promise<string | null> {
  const data = await cdekFetch('POST', '/webhooks', { url: cdekWebhookUrl(), type: 'ORDER_STATUS' }) as any
  return (data?.entity?.uuid as string) ?? null
}

// Самолечение ограничено по частоте: если подписку сносит снова и снова, значит
// проблема не в ней, и бесконечно перерегистрировать — только мешать разбору.
const MAX_HEALS_PER_DAY = Number(process.env.CDEK_WEBHOOK_MAX_HEALS_PER_DAY ?? 8)
const healTimestamps: number[] = []

function healsLastDay(): number {
  const cutoff = Date.now() - 86400_000
  while (healTimestamps.length && healTimestamps[0] < cutoff) healTimestamps.shift()
  return healTimestamps.length
}

/** Только для тестов: обнуляет счётчик автовосстановлений. */
export function _resetForTests(): void { healTimestamps.length = 0 }

export type WebhookCheck = { ok: boolean; healed: boolean; total: number; reason?: string }

/**
 * Проверяет подписку ORDER_STATUS на наш URL и восстанавливает её, если пропала.
 * Никогда не бросает: сторож не должен ронять старт сервера.
 */
export async function verifyCdekWebhookSubscription(): Promise<WebhookCheck> {
  let list: any[]
  try {
    list = await listCdekWebhooks()
  } catch (e: any) {
    // недоступность СДЭКа — не повод кричать про подписку, это отдельная проблема
    logger.warn({ err: e?.message }, 'cdek-webhook-watchdog: не удалось получить список подписок')
    return { ok: false, healed: false, total: 0, reason: `запрос не прошёл: ${e?.message}` }
  }

  const want = cdekWebhookUrl()
  const ours = list.filter((w: any) => w?.type === 'ORDER_STATUS' && w?.url === want)
  if (ours.length > 0) {
    logger.info({ total: list.length }, 'cdek-webhook-watchdog: подписка на месте')
    return { ok: true, healed: false, total: list.length }
  }

  const foreign = list.filter((w: any) => w?.type === 'ORDER_STATUS')
  const reason = foreign.length > 0
    ? `подписка ORDER_STATUS ведёт не на нас: ${foreign.map((w: any) => w?.url).join(', ')}`
    : `подписок ORDER_STATUS нет (всего подписок: ${list.length})`

  const healsToday = healsLastDay()
  if (healsToday >= MAX_HEALS_PER_DAY) {
    sendAlert(
      `СДЭК: подписка на вебхуки пропала снова (${reason}). Восстанавливать перестал — ` +
      `за сутки это уже ${healsToday}-й раз, лечим симптом вместо причины.`,
      {
        tag: 'cdek',
        level: 'critical',
        hint: 'СДЭК снимает подписку из-за неудачных доставок — проверьте, не засыпает ли Render (холодный старт ~20 с дольше таймаута СДЭКа)',
        code: 'CDEK_WEBHOOK_SUBSCRIPTION_FLAPPING',
      }
    ).catch(() => {})
    return { ok: false, healed: false, total: list.length, reason }
  }

  try {
    const uuid = await registerCdekWebhook()
    healTimestamps.push(Date.now())
    logger.warn({ uuid, reason }, 'cdek-webhook-watchdog: подписка восстановлена автоматически')
    sendAlert(
      `СДЭК: подписка на вебхуки пропала (${reason}) — восстановил автоматически, uuid ${uuid}. ` +
      `Пока её не было, не приходили статусы отправлений: уведомления покупателям, ` +
      `статус в ЛК и штрихкоды в тильдиных лидах.`,
      {
        tag: 'cdek',
        level: 'high',
        hint: 'разово — ок; если повторяется, ищите причину неудачных доставок вебхука (засыпание Render)',
        code: 'CDEK_WEBHOOK_SUBSCRIPTION_HEALED',
      }
    ).catch(() => {})
    return { ok: true, healed: true, total: list.length, reason }
  } catch (e: any) {
    sendAlert(
      `СДЭК: подписки на вебхуки нет (${reason}), и восстановить не удалось: ${e?.message}`,
      {
        tag: 'cdek',
        level: 'critical',
        hint: 'восстановить вручную: npx tsx src/scripts/register-cdek-webhook.ts register',
        code: 'CDEK_WEBHOOK_SUBSCRIPTION_MISSING',
      }
    ).catch(() => {})
    return { ok: false, healed: false, total: list.length, reason }
  }
}

/** Проверка на старте и дальше по интервалу (по умолчанию раз в 30 минут). */
export function startCdekWebhookWatchdog(): void {
  const everyMs = Number(process.env.CDEK_WEBHOOK_CHECK_INTERVAL_MS ?? 30 * 60 * 1000)
  void verifyCdekWebhookSubscription()
  setInterval(() => { void verifyCdekWebhookSubscription() }, everyMs)
  logger.info({ everyMinutes: everyMs / 60000, autoHealPerDay: MAX_HEALS_PER_DAY }, 'сторож подписки CDEK настроен')
}
