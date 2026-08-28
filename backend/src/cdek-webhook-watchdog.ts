import pino from 'pino'
import { sendAlert } from './alerts.js'
import { cdekFetch } from './cdek.js'

const logger = pino()

// ── Сторож подписки на вебхуки СДЭК ──────────────────────────────────────────
//
// Вебхук СДЭКа — единственный триггер сразу трёх вещей: уведомления покупателю
// об отправке, статуса заказа в ЛК и дозаполнения трек-ссылки/штрихкода в
// тильдиных лидах. Пропажа подписки не видна никак: нет вебхука — не запускается
// обработчик — некому алертить.
//
// История. 25.08.2026 подписка исчезла впервые (заметили через двое суток,
// случайно). 26.08 восстановили руками — пропала снова за шесть часов. 27.08
// сторож перерегистрировал её восемь раз подряд, и каждый раз она исчезала в
// пределах получаса, пока не сработал суточный лимит. А 28.08 в 09:58, когда
// лимит освободился и была сделана ОДНА регистрация, подписка прожила больше
// десяти часов подряд.
//
// Отсюда рабочая версия: частая перерегистрация делала хуже, а не лучше — каждый
// POST заводит новую сущность, и в этой чехарде подписка не удерживалась.
// Поэтому сторож теперь осторожен: перепроверяет пропажу вторым запросом, лечит
// редко и убеждается, что регистрация действительно закрепилась.

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

// Лимит самолечений. Живёт в памяти, а Render на free-tier перезапускается часто —
// значит лимит слабее, чем кажется, и это ещё одна причина держать его низким.
const MAX_HEALS_PER_DAY = Number(process.env.CDEK_WEBHOOK_MAX_HEALS_PER_DAY ?? 4)
// Пауза перед повторной проверкой: разовый пустой ответ СДЭКа не повод заводить
// новую подписку поверх существующей.
const RECHECK_DELAY_MS = Number(process.env.CDEK_WEBHOOK_RECHECK_DELAY_MS ?? 20_000)
// Пока состояние не меняется, повторять один и тот же critical незачем.
const FLAPPING_COOLDOWN_MS = Number(process.env.CDEK_WEBHOOK_FLAPPING_COOLDOWN_MS ?? 6 * 60 * 60 * 1000)

const healTimestamps: number[] = []
let flappingAlertedAt = 0

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function healsLastDay(): number {
  const cutoff = Date.now() - 86400_000
  while (healTimestamps.length && healTimestamps[0] < cutoff) healTimestamps.shift()
  return healTimestamps.length
}

/** Только для тестов: обнуляет счётчики. */
export function _resetForTests(): void {
  healTimestamps.length = 0
  flappingAlertedAt = 0
}

export type WebhookCheck = { ok: boolean; healed: boolean; total: number; reason?: string }

/** Ищет нашу подписку в списке; если не нашлась — объясняет, что вместо неё. */
function findOurs(list: any[]): { found: boolean; reason: string } {
  const want = cdekWebhookUrl()
  if (list.some((w: any) => w?.type === 'ORDER_STATUS' && w?.url === want)) {
    return { found: true, reason: '' }
  }
  const foreign = list.filter((w: any) => w?.type === 'ORDER_STATUS')
  return {
    found: false,
    reason: foreign.length > 0
      ? `подписка ORDER_STATUS ведёт не на нас: ${foreign.map((w: any) => w?.url).join(', ')}`
      : `подписок ORDER_STATUS нет (всего подписок: ${list.length})`,
  }
}

/**
 * Проверяет подписку ORDER_STATUS на наш URL и восстанавливает её, если она
 * действительно пропала. Никогда не бросает: сторож не должен ронять сервер.
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

  if (findOurs(list).found) {
    logger.info({ total: list.length }, 'cdek-webhook-watchdog: подписка на месте')
    return { ok: true, healed: false, total: list.length }
  }

  // Перепроверяем перед тем, как что-то создавать: лишняя подписка поверх живой
  // хуже, чем лишние 20 секунд ожидания.
  await sleep(RECHECK_DELAY_MS)
  try {
    list = await listCdekWebhooks()
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'cdek-webhook-watchdog: перепроверка не прошла')
    return { ok: false, healed: false, total: 0, reason: `перепроверка не прошла: ${e?.message}` }
  }
  const check = findOurs(list)
  if (check.found) {
    logger.info('cdek-webhook-watchdog: подписка нашлась при перепроверке, ложная тревога')
    return { ok: true, healed: false, total: list.length }
  }

  const reason = check.reason
  const healsToday = healsLastDay()
  if (healsToday >= MAX_HEALS_PER_DAY) {
    const now = Date.now()
    if (now - flappingAlertedAt >= FLAPPING_COOLDOWN_MS) {
      flappingAlertedAt = now
      sendAlert(
        `СДЭК: подписка на вебхуки пропадает раз за разом (${reason}). За сутки уже ${healsToday} ` +
        `восстановлений — перерегистрировать перестал: чаще делать только хуже. Пока её нет, ` +
        `не приходят статусы отправлений; штрихкоды подберёт ночной свип, но уведомления ` +
        `покупателям и статусы в ЛК теряются.`,
        {
          tag: 'cdek',
          level: 'critical',
          hint: 'нужен разбор со стороны СДЭК: кто и почему снимает подписку на общем аккаунте (там же интеграция Тильды)',
          code: 'CDEK_WEBHOOK_SUBSCRIPTION_FLAPPING',
        }
      ).catch(() => {})
    }
    return { ok: false, healed: false, total: list.length, reason }
  }

  try {
    const uuid = await registerCdekWebhook()
    healTimestamps.push(Date.now())

    // Убеждаемся, что регистрация закрепилась: СДЭК отвечает SUCCESSFUL на CREATE,
    // но нас интересует не ответ, а состояние.
    await sleep(RECHECK_DELAY_MS)
    const after = await listCdekWebhooks().catch(() => [] as any[])
    const stuck = findOurs(after).found

    logger.warn({ uuid, reason, stuck }, 'cdek-webhook-watchdog: подписка восстановлена')
    sendAlert(
      `СДЭК: подписка на вебхуки пропала (${reason}) — восстановил, uuid ${uuid}` +
      `${stuck ? '' : ' ⚠️ но в списке она так и не появилась'}. Пока её не было, не приходили ` +
      `статусы отправлений: уведомления покупателям, статус в ЛК и штрихкоды в тильдиных лидах.`,
      {
        tag: 'cdek',
        level: stuck ? 'high' : 'critical',
        hint: stuck
          ? 'разово — ок; повторяется — разбираться со стороны СДЭК, аккаунт общий с Тильдой'
          : 'СДЭК принял регистрацию, но подписки в списке нет — вопрос к поддержке СДЭК',
        code: 'CDEK_WEBHOOK_SUBSCRIPTION_HEALED',
      }
    ).catch(() => {})
    return { ok: stuck, healed: true, total: list.length, reason }
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
