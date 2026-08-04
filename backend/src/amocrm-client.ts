import { sendAlert } from './alerts.js'

// ── Единый клиент amoCRM: одна очередь на все обращения ───────────────────────
//
// Лимит amoCRM — ~7 запросов в секунду на интеграцию. Раньше в API ходили четыре
// независимых пути (создание лида, CDEK-синк, вебхук учёта отгрузок, ночной
// delta-sync), каждый своим `fetch` и без общего ограничителя. При всплеске
// продаж 01–02.08.2026 (94 заказа за двое суток против обычных 2–7 в день)
// менеджер разгребал заказы пачками, amoCRM отвечал штормом вебхуков, а мы на
// каждый вебхук стучались обратно без пауз и без ретрая на 429 — 03.08.2026
// аккаунт словил блокировку за превышение лимитов.
//
// Теперь ВСЕ запросы идут через одну очередь с одним воркером и паузой между
// стартами. Очередь ничего не выбрасывает — только выстраивает в линию, поэтому
// ни один заказ не может потеряться из-за троттлинга.
//
// Две полосы приоритета:
//   high — всё, что в критическом пути заказа (лид при оплате, трек, штрихкод).
//          Обгоняет фон, чтобы оплата не ждала, пока разгребётся шторм вебхуков.
//   low  — фоновая работа (вебхук учёта отгрузок, ночной синк). Может подождать.
//
// Побочный полезный эффект одного воркера: пауза при 429 автоматически
// становится глобальной — тормозим всю интеграцию разом, как и просит amoCRM.

export type Lane = 'high' | 'low'

// 200 мс между стартами ≈ 5 rps при лимите 7 — запас на параллельные интеграции
// в том же аккаунте (Тильда, виджеты), которые тоже едят общий лимит аккаунта.
const MIN_INTERVAL_MS = Number(process.env.AMOCRM_MIN_INTERVAL_MS ?? 200)
const REQUEST_TIMEOUT_MS = 12_000
const MAX_429_RETRIES = 4

// Глубина, после которой очередь считается ненормальной. Штатно в ней единицы
// задач; сотни — признак шторма, о котором надо узнать сразу, а не постфактум.
const DEPTH_ALERT_THRESHOLD = Number(process.env.AMOCRM_QUEUE_DEPTH_ALERT ?? 200)
const DEPTH_ALERT_COOLDOWN_MS = 5 * 60_000
// Сколько заказ может простоять в очереди, прежде чем это станет проблемой.
const HIGH_LANE_WAIT_ALERT_MS = 15_000

export function getAmoBase(): string {
  const sub = process.env.AMOCRM_SUBDOMAIN
  if (!sub) throw new Error('AMOCRM_SUBDOMAIN not set')
  return `https://${sub}.amocrm.ru`
}

export function getAmoToken(): string {
  const token = process.env.AMOCRM_ACCESS_TOKEN
  if (!token) throw new Error('AMOCRM_ACCESS_TOKEN not set')
  return token
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── Очередь ───────────────────────────────────────────────────────────────────

type Job = { run: () => Promise<void>; enqueuedAt: number; lane: Lane }

const lanes: Record<Lane, Job[]> = { high: [], low: [] }
let pumping = false
let lastStartedAt = 0
let depthAlertedAt = 0
let waitAlertedAt = 0

export function queueDepth(): { high: number; low: number; total: number } {
  return { high: lanes.high.length, low: lanes.low.length, total: lanes.high.length + lanes.low.length }
}

/** Очередь распухла — почти наверняка шторм вебхуков. Не выбрасываем, но сообщаем. */
function checkDepth(): void {
  const { high, low, total } = queueDepth()
  if (total < DEPTH_ALERT_THRESHOLD) return
  const now = Date.now()
  if (now - depthAlertedAt < DEPTH_ALERT_COOLDOWN_MS) return
  depthAlertedAt = now
  sendAlert(
    `amoCRM: очередь запросов разрослась до ${total} (заказы: ${high}, фон: ${low}). ` +
    `Запросы не теряются, но фоновая обработка отстаёт.`,
    {
      tag: 'amocrm',
      level: 'moderate',
      hint: 'шторм вебхуков — вероятно, массовая операция со сделками в CRM',
      code: 'AMOCRM_QUEUE_BACKLOG',
    }
  ).catch(() => {})
}

/** Заказ слишком долго ждал очереди — оплата обрабатывается медленнее, чем должна. */
function checkWait(job: Job): void {
  if (job.lane !== 'high') return
  const waited = Date.now() - job.enqueuedAt
  if (waited < HIGH_LANE_WAIT_ALERT_MS) return
  const now = Date.now()
  if (now - waitAlertedAt < DEPTH_ALERT_COOLDOWN_MS) return
  waitAlertedAt = now
  sendAlert(
    `amoCRM: запрос по заказу простоял в очереди ${Math.round(waited / 1000)} с перед отправкой.`,
    {
      tag: 'amocrm',
      level: 'high',
      hint: 'очередь забита фоновыми задачами или amoCRM отвечает очень медленно',
      code: 'AMOCRM_QUEUE_SLOW',
    }
  ).catch(() => {})
}

function enqueue<T>(lane: Lane, task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    lanes[lane].push({
      lane,
      enqueuedAt: Date.now(),
      // run никогда не бросает — иначе исключение одной задачи остановило бы воркер
      run: async () => {
        try {
          resolve(await task())
        } catch (e) {
          reject(e)
        }
      },
    })
    checkDepth()
    void pump()
  })
}

/**
 * Единственный воркер. Забирает high, пока он не пуст, потом low.
 * Голодание фоновой полосы допустимо: она догонит, а ночной delta-sync
 * подчистит всё, что вебхуки не успели обработать.
 */
async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const job = lanes.high.shift() ?? lanes.low.shift()
      if (!job) break
      const wait = lastStartedAt + MIN_INTERVAL_MS - Date.now()
      if (wait > 0) await sleep(wait)
      lastStartedAt = Date.now()
      checkWait(job)
      await job.run()
    }
  } finally {
    pumping = false
  }
}

// ── Запрос ────────────────────────────────────────────────────────────────────

/**
 * Системные ошибки доступа алертим прямо здесь: они означают, что сломана вся
 * интеграция, а не один вызов, и вызывающий код об этом судить не может.
 * Остальные коды (4xx по телу запроса, 5xx) отдаём наверх — там свои ретраи
 * и свои алерты, дублировать не нужно.
 */
function alertOnAccessError(status: number, method: string, path: string, body: string): void {
  if (status === 401) {
    sendAlert(
      `amoCRM: 401 на ${method} ${path} — токен не принят.`,
      {
        tag: 'amocrm',
        level: 'critical',
        hint: 'долгоживущий токен отозван или пересоздан — обновите AMOCRM_ACCESS_TOKEN',
        code: 'AMOCRM_TOKEN_INVALID',
      }
    ).catch(() => {})
    return
  }
  if (status === 403) {
    sendAlert(
      `amoCRM: 403 на ${method} ${path} — доступ запрещён. ${body.slice(0, 200)}`,
      {
        tag: 'amocrm',
        level: 'critical',
        hint: 'похоже на блокировку интеграции за превышение лимитов — заказы перестанут попадать в CRM',
        code: 'AMOCRM_ACCESS_FORBIDDEN',
      }
    ).catch(() => {})
    return
  }
  if (status === 429) {
    sendAlert(
      `amoCRM: 429 на ${method} ${path} — лимит не отпустил за ${MAX_429_RETRIES} попытки.`,
      {
        tag: 'amocrm',
        level: 'high',
        hint: 'нагрузка выше лимита дольше, чем длится наш backoff',
        code: 'AMOCRM_RATE_LIMITED',
      }
    ).catch(() => {})
  }
}

async function execute(method: string, path: string, body: unknown, attempt: number): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const resp = await fetch(`${getAmoBase()}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${getAmoToken()}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })

    if (resp.status === 204) {
      clearTimeout(timer)
      return null
    }

    // 429 — ждём прямо в слоте воркера: очередь одна, поэтому пауза тормозит
    // всю интеграцию разом, а не только этот вызов. Именно это и нужно.
    if (resp.status === 429 && attempt <= MAX_429_RETRIES) {
      const retryAfter = Number(resp.headers.get('Retry-After'))
      clearTimeout(timer)
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : [500, 1500, 4000, 8000][attempt - 1]
      await sleep(delayMs)
      return execute(method, path, body, attempt + 1)
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      clearTimeout(timer)
      alertOnAccessError(resp.status, method, path, text)
      throw new Error(`amoCRM ${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 300)}`)
    }

    const data = await resp.json()
    clearTimeout(timer)
    return data
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

/**
 * Запрос к amoCRM через общую очередь.
 * Бросает при неуспехе — ретраи «по смыслу» остаются на вызывающем коде
 * (например, triggerAmoCrmAsync с тремя попытками и critical-алертом).
 *
 * @param lane 'high' — критический путь заказа (по умолчанию), 'low' — фон.
 */
export function amoFetch(
  method: string,
  path: string,
  body?: unknown,
  lane: Lane = 'high'
): Promise<unknown> {
  return enqueue(lane, () => execute(method, path, body, 1))
}
