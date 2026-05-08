import { ProxyAgent, fetch as undiciFetch } from 'undici'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const proxyUrl = process.env.TG_PROXY_URL?.trim()
export const proxyDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined

if (proxyUrl) {
  console.log(`[proxy] TG-запросы пойдут через прокси: ${maskProxy(proxyUrl)}`)
} else {
  console.log('[proxy] TG_PROXY_URL не задан — прямые запросы к api.telegram.org')
}

function maskProxy(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.username ? '***:***@' : ''}${u.host}`
  } catch {
    return '***'
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAILED_LOG = path.join(__dirname, '..', 'failed-tg-notifications.json')

const RETRY_DELAYS_MS = [1000, 3000, 9000]

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function maskUrl(url: string): string {
  return url.replace(/bot\d+:[A-Za-z0-9_-]+/, 'bot***')
}

function recordFailure(entry: Record<string, any>) {
  try {
    let arr: any[] = []
    if (fs.existsSync(FAILED_LOG)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(FAILED_LOG, 'utf8'))
        if (Array.isArray(parsed)) arr = parsed
      } catch {}
    }
    arr.push({ timestamp: new Date().toISOString(), ...entry })
    if (arr.length > 1000) arr = arr.slice(-1000)
    fs.writeFileSync(FAILED_LOG, JSON.stringify(arr, null, 2), 'utf8')
  } catch (e: any) {
    console.error('[proxy] не удалось записать failed-tg-notifications.json:', e?.message)
  }
}

// fetch для Telegram Bot API: через прокси (если задан) + 3 повтора 1/3/9с.
// 4xx (кроме 429) считаем финальной ошибкой и не ретраим — это ошибка нашего запроса, не сети.
export async function tgFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let lastError: any
  let lastResponse: Response | undefined
  const masked = maskUrl(url)

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = (await undiciFetch(url, {
        ...(init as any),
        dispatcher: proxyDispatcher,
      })) as unknown as Response

      if (res.ok) return res

      // 4xx (кроме 429) — финальный, ретраить бесполезно
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        return res
      }

      lastResponse = res
      lastError = new Error(`HTTP ${res.status}`)
    } catch (e: any) {
      lastError = e
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[attempt]
      console.warn(`[tgFetch] попытка ${attempt + 1} не удалась для ${masked}: ${lastError?.message}, повтор через ${delay}мс`)
      await sleep(delay)
    }
  }

  recordFailure({
    url: masked,
    method: (init as any)?.method || 'GET',
    error: lastError?.message,
    status: lastResponse?.status,
  })
  console.error(`[tgFetch] все попытки исчерпаны для ${masked}: ${lastError?.message}`)

  if (lastResponse) return lastResponse
  throw lastError
}
