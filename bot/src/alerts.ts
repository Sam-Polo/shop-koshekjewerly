import { tgFetch } from './proxy.js'

const CHANNEL_CHAT_ID = process.env.ERROR_CHANNEL_CHAT_ID?.trim() || ''
const MANAGER_CHAT_ID = process.env.TG_MANAGER_CHAT_ID?.trim() || ''

if (!CHANNEL_CHAT_ID) {
  console.warn('[alerts] ERROR_CHANNEL_CHAT_ID не задан — алерты в канал отключены')
}

// Отправляем менеджеру если канал алертов недоступен. Cooldown 1 час чтобы не спамить.
let channelIssueNotifiedAt = 0

async function notifyManagerChannelIssue(detail: string): Promise<void> {
  if (!MANAGER_CHAT_ID) return
  const now = Date.now()
  if (now - channelIssueNotifiedAt < 60 * 60 * 1000) return
  channelIssueNotifiedAt = now
  const token = process.env.TG_BOT_TOKEN
  if (!token) return
  const text =
    '⚠️ Внимание!\n\n' +
    'Бот не может отправлять уведомления об ошибках, потому что чат для алертов не найден.\n\n' +
    `Причина: ${detail}\n\n` +
    'Что делать: попросите разработчика обновить настройку ERROR_CHANNEL_CHAT_ID в конфиге бота.'
  await tgFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: MANAGER_CHAT_ID, text })
  }).catch(() => {})
}

// анти-флуд: дедуп одинаковых сообщений в скользящем окне
const DEDUP_WINDOW_MS = 60_000
const dedupMap = new Map<string, number>() // хэш → время последней отправки

// token bucket: не более MAX_PER_MIN алертов в минуту
const MAX_PER_MIN = 20
let bucketTokens = MAX_PER_MIN
let bucketRefreshedAt = Date.now()
let suppressedCount = 0 // сколько подавлено с момента последнего сброса

function refreshBucket() {
  const now = Date.now()
  if (now - bucketRefreshedAt >= 60_000) {
    if (suppressedCount > 0) {
      // fire-and-forget сводка о подавленных (без рекурсии — прямой fetch)
      const summary = `⚠️ [alerts] подавлено ${suppressedCount} алертов (rate-limit)\n${new Date().toISOString()}`
      _rawSend(summary).catch(() => {})
    }
    bucketTokens = MAX_PER_MIN
    bucketRefreshedAt = now
    suppressedCount = 0
  }
}

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return String(h >>> 0)
}

function escapeHtml(text: string): string {
  if (!text) return ''
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

// отправляет напрямую без throttle (для сводки о подавленных)
async function _rawSend(text: string): Promise<void> {
  const token = process.env.TG_BOT_TOKEN
  if (!token || !CHANNEL_CHAT_ID) return
  const resp = await tgFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHANNEL_CHAT_ID, text, parse_mode: 'HTML' })
  })
  if (!resp.ok) {
    const result = await resp.json().catch(() => ({})) as any
    const description: string = result?.description ?? ''
    if (/chat not found/i.test(description)) {
      notifyManagerChannelIssue(
        `Чат с ID ${CHANNEL_CHAT_ID} не найден в Telegram. ` +
        `Возможно, чат был удалён или стал супергруппой — тогда его ID изменился.`
      ).catch(() => {})
    }
  }
}

export type AlertLevel = 'critical' | 'high' | 'moderate' | 'low' | 'info'

export interface AlertOptions {
  tag?: string
  level?: AlertLevel
  hint?: string  // русское объяснение/предположение причины
  code?: string  // краткое техническое название ошибки
}

const LEVEL_LABEL: Record<AlertLevel, string> = {
  critical: '🔴 КРИТИЧЕСКИЙ',
  high: '🟠 ВЫСОКИЙ',
  moderate: '🟡 УМЕРЕННЫЙ',
  low: '🔵 НИЗКИЙ',
  info: '🟢 ИНФОРМАЦИЯ',
}

function buildMessage(text: string, opts: AlertOptions | undefined): string {
  const level: AlertLevel = opts?.level ?? 'high'
  const tagStr = opts?.tag ? ` · [${escapeHtml(opts.tag)}]` : ''
  const ts = new Date().toISOString()
  const lines: string[] = []
  lines.push(`${LEVEL_LABEL[level]}${tagStr}`)
  lines.push('')
  lines.push(escapeHtml(text))
  if (opts?.hint) lines.push(`<i>Вероятно: ${escapeHtml(opts.hint)}</i>`)
  if (opts?.code) lines.push(`<code>${escapeHtml(opts.code)}</code>`)
  lines.push('')
  lines.push(`<i>${ts}</i>`)
  return lines.join('\n')
}

/**
 * Постит в ERROR_CHANNEL_CHAT_ID. Никогда не бросает исключение.
 * Встроен дедуп (одно и то же сообщение раз в 60 с) и rate-limit (20/мин).
 */
export async function sendAlert(text: string, opts?: AlertOptions): Promise<void> {
  if (!CHANNEL_CHAT_ID) return

  try {
    refreshBucket()

    const full = buildMessage(text, opts)
    // хэшируем без временнóй метки, чтобы дедуп работал правильно
    const hashInput = `${opts?.level ?? 'high'}|${opts?.tag ?? ''}|${text.slice(0, 150)}`
    const hash = simpleHash(hashInput)
    const now = Date.now()
    const lastSent = dedupMap.get(hash)
    if (lastSent && now - lastSent < DEDUP_WINDOW_MS) {
      suppressedCount++
      return
    }

    if (bucketTokens <= 0) {
      suppressedCount++
      return
    }

    dedupMap.set(hash, now)
    bucketTokens--

    // чистим старые записи раз в N вызовов чтобы не копить Map
    if (dedupMap.size > 500) {
      const cutoff = now - DEDUP_WINDOW_MS
      for (const [k, t] of dedupMap) {
        if (t < cutoff) dedupMap.delete(k)
      }
    }

    await _rawSend(full)
  } catch {
    // намеренно проглатываем — алерт не должен ронять процесс
  }
}
