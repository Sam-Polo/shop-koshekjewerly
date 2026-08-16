import crypto from 'node:crypto'

/**
 * Проверка подписи initData от Telegram Mini Apps.
 *
 * Зачем: без неё chat_id — это просто строка, которую клиент присылает сам. Для создания
 * заказа подмена почти безобидна (платит-то подделыватель), но для личного кабинета она
 * означает выдачу чужих ПДн: chat_id в Telegram последовательные, поэтому перебором
 * можно выгрузить ФИО, телефоны и адреса всех покупателей.
 *
 * Алгоритм (docs Telegram, «Validating data received via the Mini App»):
 *   secret_key   = HMAC_SHA256(key = "WebAppData", message = <bot_token>)
 *   data_check   = все поля КРОМЕ hash, отсортированные по имени, «k=v» через \n
 *   ожидаемый    = HMAC_SHA256(key = secret_key, message = data_check) в hex
 *
 * Поле `signature` (появилось для сторонней Ed25519-проверки) из data_check_string
 * НЕ исключается — hash считается по всем полям кроме самого hash.
 *
 * Модуль намеренно чистый: ни сети, ни env, ни Sheets — чтобы проверялся тестами целиком.
 */

export type InitDataResult =
  | { ok: true; userId: string; displayName: string | null; authDate: number }
  | { ok: false; reason: InitDataFailure }

export type InitDataFailure =
  | 'empty'          // initData не пришёл
  | 'no_token'       // на сервере не задан токен бота — поломка окружения
  | 'no_hash'        // в initData нет подписи
  | 'bad_signature'  // подпись не сошлась: подделка либо чужой бот
  | 'expired'        // подпись верна, но данные слишком старые
  | 'no_user'        // подпись верна, но поля user нет

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60

function hmac(key: crypto.BinaryLike | crypto.KeyObject, message: string): Buffer {
  return crypto.createHmac('sha256', key).update(message).digest()
}

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
  nowMs: number = Date.now()
): InitDataResult {
  if (!initData) return { ok: false, reason: 'empty' }
  if (!botToken) return { ok: false, reason: 'no_token' }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')
  if (!hash) return { ok: false, reason: 'no_hash' }

  // URLSearchParams уже декодировал значения — именно по декодированным Telegram и считает
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secretKey = hmac('WebAppData', botToken)
  const expected = hmac(secretKey, dataCheckString).toString('hex')

  // сравнение постоянного времени: обычное === утекает информацию посимвольно
  const received = Buffer.from(hash, 'hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  if (received.length !== expectedBuf.length) return { ok: false, reason: 'bad_signature' }
  if (!crypto.timingSafeEqual(received, expectedBuf)) return { ok: false, reason: 'bad_signature' }

  // Подпись верна, но она бессрочна: перехваченный initData работал бы вечно.
  // auth_date — момент открытия мини-аппа, поэтому окно щедрое (сутки): пользователь
  // может держать приложение открытым, и разлогинивать его посреди сессии незачем.
  const authDate = Number(params.get('auth_date') ?? '0')
  if (!authDate || Number.isNaN(authDate)) return { ok: false, reason: 'expired' }
  const ageSeconds = nowMs / 1000 - authDate
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'expired' }

  const userRaw = params.get('user')
  if (!userRaw) return { ok: false, reason: 'no_user' }
  try {
    const user = JSON.parse(userRaw)
    const userId = user?.id?.toString()
    if (!userId) return { ok: false, reason: 'no_user' }
    const nameParts = [user.first_name, user.last_name].filter(Boolean)
    return {
      ok: true,
      userId,
      displayName: nameParts.length > 0 ? nameParts.join(' ') : null,
      authDate,
    }
  } catch {
    return { ok: false, reason: 'no_user' }
  }
}
