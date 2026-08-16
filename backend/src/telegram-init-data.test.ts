import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { validateTelegramInitData } from './telegram-init-data.js'

const BOT_TOKEN = '123456:TEST-TOKEN-abcdefghijklmnopqrstuvwxyz'
const NOW_MS = 1_786_900_000_000
const AUTH_DATE = Math.floor(NOW_MS / 1000) - 60 // подписано минуту назад

/**
 * Собирает валидный initData тем же алгоритмом, которым его подписывает Telegram.
 * Это не «тест проверяет сам себя»: подпись строится независимо от проверяющего кода,
 * а тесты ниже ломают её разными способами и ждут отказа.
 */
function signInitData(fields: Record<string, string>, token = BOT_TOKEN): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map(k => `${k}=${fields[k]}`)
    .join('\n')
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest()
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  const params = new URLSearchParams({ ...fields, hash })
  return params.toString()
}

const USER = JSON.stringify({ id: 123456789, first_name: 'Семён', last_name: 'Половодов' })

function validInitData(overrides: Record<string, string> = {}): string {
  return signInitData({
    auth_date: String(AUTH_DATE),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: USER,
    ...overrides,
  })
}

describe('validateTelegramInitData', () => {
  it('принимает корректно подписанный initData и достаёт пользователя', () => {
    const res = validateTelegramInitData(validInitData(), BOT_TOKEN, undefined, NOW_MS)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.userId).toBe('123456789')
    expect(res.displayName).toBe('Семён Половодов')
    expect(res.authDate).toBe(AUTH_DATE)
  })

  it('отвергает подменённый chat_id — главный сценарий атаки', () => {
    // берём валидные данные и вручную подставляем чужого пользователя, не трогая hash
    const good = validInitData()
    const params = new URLSearchParams(good)
    params.set('user', JSON.stringify({ id: 987654321, first_name: 'Чужой' }))

    const res = validateTelegramInitData(params.toString(), BOT_TOKEN, undefined, NOW_MS)
    expect(res).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('отвергает подпись, сделанную токеном другого бота', () => {
    const foreign = signInitData(
      { auth_date: String(AUTH_DATE), user: USER },
      '999999:SOME-OTHER-BOT-TOKEN'
    )
    const res = validateTelegramInitData(foreign, BOT_TOKEN, undefined, NOW_MS)
    expect(res).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('отвергает мусорный hash и hash неверной длины', () => {
    const params = new URLSearchParams(validInitData())
    params.set('hash', 'deadbeef')
    expect(validateTelegramInitData(params.toString(), BOT_TOKEN, undefined, NOW_MS))
      .toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('отвергает просроченный initData, даже с верной подписью', () => {
    const old = signInitData({
      auth_date: String(Math.floor(NOW_MS / 1000) - 48 * 60 * 60), // двое суток назад
      user: USER,
    })
    const res = validateTelegramInitData(old, BOT_TOKEN, 24 * 60 * 60, NOW_MS)
    expect(res).toEqual({ ok: false, reason: 'expired' })
  })

  it('пропускает свежий initData в пределах окна', () => {
    const recent = signInitData({
      auth_date: String(Math.floor(NOW_MS / 1000) - 23 * 60 * 60),
      user: USER,
    })
    expect(validateTelegramInitData(recent, BOT_TOKEN, 24 * 60 * 60, NOW_MS).ok).toBe(true)
  })

  it('не падает и не пропускает при пустом вводе и отсутствии токена', () => {
    expect(validateTelegramInitData('', BOT_TOKEN, undefined, NOW_MS))
      .toEqual({ ok: false, reason: 'empty' })
    expect(validateTelegramInitData(validInitData(), '', undefined, NOW_MS))
      .toEqual({ ok: false, reason: 'no_token' })
  })

  it('требует наличие hash', () => {
    const params = new URLSearchParams(validInitData())
    params.delete('hash')
    expect(validateTelegramInitData(params.toString(), BOT_TOKEN, undefined, NOW_MS))
      .toEqual({ ok: false, reason: 'no_hash' })
  })

  it('верная подпись без поля user не даёт доступа', () => {
    const noUser = signInitData({ auth_date: String(AUTH_DATE), query_id: 'AAH' })
    expect(validateTelegramInitData(noUser, BOT_TOKEN, undefined, NOW_MS))
      .toEqual({ ok: false, reason: 'no_user' })
  })

  it('поле signature участвует в подписи и не ломает проверку', () => {
    const withSignature = validInitData({ signature: 'abcDEF123_-' })
    expect(validateTelegramInitData(withSignature, BOT_TOKEN, undefined, NOW_MS).ok).toBe(true)
  })

  it('пользователь без фамилии — displayName только имя', () => {
    const data = signInitData({
      auth_date: String(AUTH_DATE),
      user: JSON.stringify({ id: 555, first_name: 'Оля' }),
    })
    const res = validateTelegramInitData(data, BOT_TOKEN, undefined, NOW_MS)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.displayName).toBe('Оля')
  })
})
