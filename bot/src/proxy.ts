import { Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function maskProxy(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.username ? '***:***@' : ''}${u.host}`
  } catch {
    return '***'
  }
}

// определяет, является ли ошибка сетевой/прокси (для решения о фейловере на резервный прокси).
// HTTP-ответы любого кода — НЕ сетевые ошибки: значит запрос дошёл до TG, ответ валиден, не ретраим.
function isNetworkError(err: any): boolean {
  if (!err) return false
  const code: string | undefined = err.code || err.cause?.code
  const name: string | undefined = err.name || err.cause?.name
  const message: string = String(err.message ?? '') + ' ' + String(err.cause?.message ?? '')

  const codes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
    'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ])
  if (code && codes.has(code)) return true

  const names = new Set([
    'ConnectTimeoutError', 'SocketError', 'HeadersTimeoutError', 'BodyTimeoutError',
  ])
  if (name && names.has(name)) return true

  if (/fetch failed|socket hang up|network is unreachable/i.test(message)) return true
  return false
}

// Dispatcher с резервным прокси.
// Каждый запрос сначала идёт через primary. Если primary отдаёт сетевую ошибку
// (а не HTTP-ответ) — повторяем тот же запрос через backup. HTTP-ответы (включая 4xx/5xx)
// не считаются сбоем прокси — это валидный ответ от Telegram, его не надо обходить.
// Если backup не задан — поведение идентично обычному ProxyAgent (без фейловера).
// duck-typed dispatcher: undici fetch вызывает только .dispatch().
// Класс не extends Dispatcher специально — у undici overload'ы destroy() с callback,
// которые не дружат с async/Promise-сигнатурой; приводим к Dispatcher на экспорте.
class FailoverProxyDispatcher {
  private primary: ProxyAgent
  private backup: ProxyAgent | null

  constructor(primaryUrl: string, backupUrl: string | null) {
    this.primary = new ProxyAgent(primaryUrl)
    this.backup = backupUrl ? new ProxyAgent(backupUrl) : null
  }

  dispatch(opts: any, handler: any): boolean {
    const backup = this.backup
    if (!backup) {
      return this.primary.dispatch(opts, handler)
    }

    // защита от повторного вызова терминальных методов оригинального handler'а,
    // если ошибка пришла уже после того как часть ответа была отдана наверх.
    let responseStarted = false
    let switchedToBackup = false

    const wrapped: any = {
      onConnect: (abort: any) => handler.onConnect?.(abort),
      onUpgrade: handler.onUpgrade
        ? (statusCode: number, headers: any, socket: any) => {
            responseStarted = true
            return handler.onUpgrade(statusCode, headers, socket)
          }
        : undefined,
      onResponseStarted: handler.onResponseStarted
        ? () => {
            responseStarted = true
            return handler.onResponseStarted()
          }
        : undefined,
      onHeaders: (statusCode: number, headers: any, resume: () => void, statusText: string) => {
        responseStarted = true
        return handler.onHeaders?.(statusCode, headers, resume, statusText) ?? true
      },
      onData: (chunk: Buffer) => handler.onData?.(chunk) ?? true,
      onComplete: (trailers: any) => handler.onComplete?.(trailers),
      onBodySent: handler.onBodySent ? (...args: any[]) => handler.onBodySent(...args) : undefined,
      onError: (err: Error) => {
        if (!switchedToBackup && !responseStarted && isNetworkError(err)) {
          switchedToBackup = true
          console.warn(`[proxy] primary упал (${(err as any).code ?? err.name ?? err.message}), переключаюсь на резервный прокси`)
          try {
            // на backup передаём ОРИГИНАЛЬНЫЙ handler — wrapped уже отыграл свою роль
            backup.dispatch(opts, handler)
            return
          } catch (e: any) {
            return handler.onError?.(e)
          }
        }
        return handler.onError?.(err)
      },
    }

    try {
      return this.primary.dispatch(opts, wrapped)
    } catch (e: any) {
      // синхронный отказ primary (например, dispatcher уже закрыт) — пробуем backup
      if (!switchedToBackup && isNetworkError(e)) {
        switchedToBackup = true
        console.warn(`[proxy] primary упал синхронно (${e.code ?? e.message}), переключаюсь на резервный прокси`)
        try {
          return backup.dispatch(opts, handler)
        } catch (e2: any) {
          handler.onError?.(e2)
          return false
        }
      }
      handler.onError?.(e)
      return false
    }
  }

  async close(): Promise<void> {
    const tasks: Promise<void>[] = [this.primary.close()]
    if (this.backup) tasks.push(this.backup.close())
    await Promise.allSettled(tasks)
  }

  async destroy(err: Error | null = null): Promise<void> {
    const tasks: Promise<void>[] = [this.primary.destroy(err)]
    if (this.backup) tasks.push(this.backup.destroy(err))
    await Promise.allSettled(tasks)
  }
}

const proxyUrl = process.env.TG_PROXY_URL?.trim()
const proxyUrlBackup = process.env.TG_PROXY_URL_BACKUP?.trim() || null

export const proxyDispatcher: Dispatcher | undefined = proxyUrl
  ? (new FailoverProxyDispatcher(proxyUrl, proxyUrlBackup) as unknown as Dispatcher)
  : undefined

if (proxyUrl && proxyUrlBackup) {
  console.log(`[proxy] TG-запросы: primary=${maskProxy(proxyUrl)}, backup=${maskProxy(proxyUrlBackup)} (backup используется только при сетевом сбое primary)`)
} else if (proxyUrl) {
  console.log(`[proxy] TG-запросы пойдут через прокси: ${maskProxy(proxyUrl)} (резервный прокси не задан — установите TG_PROXY_URL_BACKUP для автофейловера)`)
} else {
  console.log('[proxy] TG_PROXY_URL не задан — прямые запросы к api.telegram.org')
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
