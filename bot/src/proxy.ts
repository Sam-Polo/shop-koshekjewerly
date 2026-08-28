import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const FAILED_LOG = process.env.TG_FAILED_LOG_PATH
  ?? path.join(__dirname, '..', 'failed-tg-notifications.json')

// паузы между повторами; env — только чтобы тесты не ждали 13 секунд на каждый случай
const RETRY_DELAYS_MS = (process.env.TG_RETRY_DELAYS_MS ?? '1000,3000,9000')
  .split(',').map(Number)
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function maskUrl(url: string): string {
  return url.replace(/bot\d+:[A-Za-z0-9_-]+/, 'bot***')
}

/** Имя метода Telegram из URL: .../botXXX/sendMessage → sendMessage */
function methodName(maskedUrl: string): string {
  return maskedUrl.split('/').pop()?.split('?')[0] ?? 'unknown'
}

/**
 * Достаёт из тела запроса, КОМУ и ЧТО не ушло.
 * Без этого запись о сбое бесполезна: знать «sendMessage не прошёл» мало,
 * переслать потерянное по такой записи нельзя.
 */
function describePayload(init: RequestInit): { chatId?: string; preview?: string } {
  const body = (init as any)?.body
  if (typeof body !== 'string') return {}
  try {
    const parsed = JSON.parse(body)
    const chatId = parsed?.chat_id !== undefined ? String(parsed.chat_id) : undefined
    const raw = parsed?.text ?? parsed?.caption
    const preview = typeof raw === 'string' ? raw.slice(0, 300) : undefined
    return { chatId, preview }
  } catch {
    return {}
  }
}

export type TgFailure = {
  url: string
  method: string
  error?: string
  status?: number
  chatId?: string
  preview?: string
}

// Об исчерпании попыток сообщаем через зарегистрированный колбэк, а не импортом
// alerts.ts: тот сам ходит через tgFetch, и прямая связь дала бы цикл импортов
// и рекурсию «алерт о том, что не удалось отправить алерт».
type FailureReporter = (failure: TgFailure) => void
let reporter: FailureReporter | null = null

export function setTgFailureReporter(fn: FailureReporter | null): void {
  reporter = fn
}

function recordFailure(entry: TgFailure) {
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
    console.error('[tgFetch] не удалось записать failed-tg-notifications.json:', e?.message)
  }
}

console.log('[proxy] TG-запросы: прямые (без прокси)')

export type TgFetchOptions = {
  /** true — не сообщать о сбое наверх. Нужно для самих алертов: иначе петля. */
  silent?: boolean
}

// fetch для Telegram Bot API: 3 повтора 1/3/9с.
// 4xx (кроме 429) считаем финальной ошибкой и не ретраим — это ошибка нашего запроса, не сети.
export async function tgFetch(
  url: string,
  init: RequestInit = {},
  opts: TgFetchOptions = {}
): Promise<Response> {
  let lastError: any
  let lastResponse: Response | undefined
  const masked = maskUrl(url)

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, init)

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

  const failure: TgFailure = {
    url: masked,
    method: (init as any)?.method || 'GET',
    error: lastError?.message,
    status: lastResponse?.status,
    ...describePayload(init),
  }
  recordFailure(failure)
  console.error(`[tgFetch] все попытки исчерпаны для ${masked}: ${lastError?.message}`)

  // Сообщение покупателю потеряно окончательно — это должно быть видно сразу,
  // а не лежать в JSON-файле на VDS, куда никто не смотрит.
  if (!opts.silent && reporter) {
    try {
      reporter({ ...failure, method: methodName(masked) })
    } catch {
      // репортер не должен ломать отправку
    }
  }

  if (lastResponse) return lastResponse
  throw lastError
}
