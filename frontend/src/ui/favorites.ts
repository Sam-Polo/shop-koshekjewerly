// Избранное покупателя.
//
// Хранилище — Telegram CloudStorage: привязано к аккаунту, синкается между устройствами
// и не создаёт нагрузки ни на бэкенд, ни на Google Sheets (квота Sheets одна на всё,
// включая заказы, а клик по сердечку — операция частая).
//
// Фолбэк на localStorage нужен двум категориям: MAX (там CloudStorage нет вовсе)
// и старым клиентам Telegram (CloudStorage появился в Bot API 6.9). Фолбэк переживает
// перезапуск приложения, но живёт на конкретном устройстве и не синкается.
//
// Следствие выбора: бэкенд избранного не видит — статистики «что чаще добавляют» не будет.

import WebApp from '../platform/webApp'

const STORAGE_KEY = 'koshek_favorites'

// CloudStorage ограничивает значение 4096 символами. Слаги длинные, поэтому режем
// список сильно раньше предела: 200 слагов — это заведомо укладывается и при этом
// заметно больше, чем реальный размер избранного у живого покупателя.
const MAX_FAVORITES = 200

type CloudStorageApi = {
  getItem: (key: string, cb: (err: string | null, value?: string) => void) => void
  setItem: (key: string, value: string, cb?: (err: string | null, ok?: boolean) => void) => void
}

// CloudStorage может отсутствовать (MAX, старый клиент) — тогда работаем на localStorage
function getCloudStorage(): CloudStorageApi | null {
  try {
    const cs = (WebApp as any)?.CloudStorage
    if (cs && typeof cs.getItem === 'function' && typeof cs.setItem === 'function') {
      return cs as CloudStorageApi
    }
  } catch {}
  return null
}

function parse(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0)
  } catch {
    return []
  }
}

function readLocal(): string[] {
  try {
    return parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return []
  }
}

function writeLocal(slugs: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slugs))
  } catch {}
}

export async function loadFavorites(): Promise<string[]> {
  const cloud = getCloudStorage()
  if (!cloud) return readLocal()

  // CloudStorage колбэчный: промисифицируем и обязательно ставим таймаут — без него
  // зависший вызов моста навсегда оставил бы избранное в состоянии загрузки
  const fromCloud = await new Promise<string[] | null>(resolve => {
    let settled = false
    const done = (value: string[] | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => done(null), 5000)
    try {
      cloud.getItem(STORAGE_KEY, (err, value) => {
        clearTimeout(timer)
        if (err) { done(null); return }
        done(parse(value))
      })
    } catch {
      clearTimeout(timer)
      done(null)
    }
  })

  // облако недоступно/ошибка — не теряем то, что успели накопить локально
  if (fromCloud === null) return readLocal()

  // держим локальную копию свежей: она и фолбэк, и мгновенный старт при следующем открытии
  writeLocal(fromCloud)
  return fromCloud
}

export async function saveFavorites(slugs: string[]): Promise<void> {
  const trimmed = slugs.slice(0, MAX_FAVORITES)
  // локально пишем всегда: это делает избранное мгновенным и переживает сбой облака
  writeLocal(trimmed)

  const cloud = getCloudStorage()
  if (!cloud) return
  try {
    cloud.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {}
}
