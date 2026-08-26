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
// Так и случилось 25.08.2026: подписка исчезла (вероятно, СДЭК снял её после
// серии неудачных доставок — бэкенд в тот момент отвечал 502), и двое суток
// покупатели не получали уведомлений об отправке, а тильдины лиды копились без
// штрихкодов. Заметили случайно.
//
// Поэтому существование подписки проверяется явно: на старте и раз в 6 часов.

function expectedUrl(): string {
  const base = (process.env.BACKEND_URL ?? 'https://shop-koshekjewerly.onrender.com').replace(/\/$/, '')
  const secret = process.env.CDEK_WEBHOOK_SECRET
  return `${base}/api/cdek/webhook${secret ? `?token=${encodeURIComponent(secret)}` : ''}`
}

const RESTORE_HINT = 'восстановить: npx tsx src/scripts/register-cdek-webhook.ts register'

export type WebhookCheck = { ok: boolean; total: number; reason?: string }

/**
 * Проверяет, что подписка ORDER_STATUS на наш URL жива.
 * Никогда не бросает: сторож не должен ронять старт сервера.
 */
export async function verifyCdekWebhookSubscription(): Promise<WebhookCheck> {
  let list: any[]
  try {
    const data = await cdekFetch('GET', '/webhooks')
    list = Array.isArray(data) ? data : (data as any)?.entity ?? []
  } catch (e: any) {
    // недоступность СДЭКа — не повод кричать про подписку, это отдельная проблема
    logger.warn({ err: e?.message }, 'cdek-webhook-watchdog: не удалось получить список подписок')
    return { ok: false, total: 0, reason: `запрос не прошёл: ${e?.message}` }
  }

  const orderStatus = list.filter((w: any) => w?.type === 'ORDER_STATUS')
  if (orderStatus.length === 0) {
    sendAlert(
      `СДЭК: подписки на вебхуки НЕТ (получено подписок: ${list.length}). ` +
      `Не приходят статусы отправлений: покупатели не получают уведомление об отправке, ` +
      `статус в ЛК не обновляется, тильдины лиды остаются без трек-ссылки и штрихкода.`,
      { tag: 'cdek', level: 'critical', hint: RESTORE_HINT, code: 'CDEK_WEBHOOK_SUBSCRIPTION_MISSING' }
    ).catch(() => {})
    return { ok: false, total: list.length, reason: 'подписок ORDER_STATUS нет' }
  }

  const want = expectedUrl()
  if (!orderStatus.some((w: any) => w?.url === want)) {
    sendAlert(
      `СДЭК: подписка на вебхуки есть, но ведёт не на наш адрес. ` +
      `Ожидаем ${want}, зарегистрировано: ${orderStatus.map((w: any) => w?.url).join(', ')}`,
      { tag: 'cdek', level: 'critical', hint: RESTORE_HINT, code: 'CDEK_WEBHOOK_SUBSCRIPTION_MISMATCH' }
    ).catch(() => {})
    return { ok: false, total: list.length, reason: 'url подписки не наш' }
  }

  logger.info({ total: list.length }, 'cdek-webhook-watchdog: подписка на месте')
  return { ok: true, total: list.length }
}

/** Запускает проверку на старте и дальше раз в 6 часов. */
export function startCdekWebhookWatchdog(): void {
  const everyMs = Number(process.env.CDEK_WEBHOOK_CHECK_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
  void verifyCdekWebhookSubscription()
  setInterval(() => { void verifyCdekWebhookSubscription() }, everyMs)
  logger.info({ everyHours: everyMs / 3600000 }, 'сторож подписки CDEK настроен')
}
