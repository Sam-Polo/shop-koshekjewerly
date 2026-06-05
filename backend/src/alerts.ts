// лёгкий fire-and-forget канал алертов.
// НЕ использует sendTelegramMessage (у него ретраи+запись в файл, это породило бы петлю при ошибке уведомлений).
// Анти-флуд: дедуп одинаковых текстов за 60 с + token bucket 20/мин.

const CHANNEL_CHAT_ID = process.env.ERROR_CHANNEL_CHAT_ID?.trim() || ''

if (!CHANNEL_CHAT_ID) {
  console.warn('[alerts] ERROR_CHANNEL_CHAT_ID не задан — алерты в канал отключены')
}

const DEDUP_WINDOW_MS = 60_000
const dedupMap = new Map<string, number>()

const MAX_PER_MIN = 20
let bucketTokens = MAX_PER_MIN
let bucketRefreshedAt = Date.now()
let suppressedCount = 0

function refreshBucket() {
  const now = Date.now()
  if (now - bucketRefreshedAt >= 60_000) {
    if (suppressedCount > 0) {
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

async function _rawSend(text: string): Promise<void> {
  const token = process.env.TG_BOT_TOKEN
  if (!token || !CHANNEL_CHAT_ID) return
  // fire-and-forget: AbortController с 5 с таймаутом
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 5_000)
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHANNEL_CHAT_ID, text, parse_mode: 'HTML' }),
      signal: ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export type AlertLevel = 'error' | 'warn' | 'info'

export interface AlertOptions {
  tag?: string
  level?: AlertLevel
}

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  error: '🔴',
  warn: '🟡',
  info: '🟢',
}

/**
 * Постит в ERROR_CHANNEL_CHAT_ID. Никогда не бросает исключение.
 * Встроен дедуп (одно и то же сообщение раз в 60 с) и rate-limit (20/мин).
 */
export async function sendAlert(text: string, opts?: AlertOptions): Promise<void> {
  if (!CHANNEL_CHAT_ID) return

  try {
    refreshBucket()

    const level: AlertLevel = opts?.level ?? 'error'
    const tag = opts?.tag ? `[${escapeHtml(opts.tag)}] ` : ''
    const ts = new Date().toISOString()
    const full = `${LEVEL_EMOJI[level]} ${tag}${escapeHtml(text)}\n<i>${ts}</i>`

    const hash = simpleHash(full.slice(0, 200))
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

    if (dedupMap.size > 500) {
      const cutoff = now - DEDUP_WINDOW_MS
      for (const [k, t] of dedupMap) {
        if (t < cutoff) dedupMap.delete(k)
      }
    }

    await _rawSend(full)
  } catch {
    // намеренно проглатываем
  }
}
