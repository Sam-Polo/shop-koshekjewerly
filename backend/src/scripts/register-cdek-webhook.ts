/**
 * Управление подпиской CDEK webhook (разовая операция).
 *
 *   npx tsx src/scripts/register-cdek-webhook.ts list            # показать текущие подписки
 *   npx tsx src/scripts/register-cdek-webhook.ts register        # подписаться на ORDER_STATUS
 *   npx tsx src/scripts/register-cdek-webhook.ts delete <uuid>   # удалить подписку
 *
 * URL подписки = BACKEND_URL + /api/cdek/webhook (+ ?token=CDEK_WEBHOOK_SECRET если задан).
 * Аккаунт CDEK тот же, что у бота → словит и Тильдины заказы.
 */

import 'dotenv/config'
import { cdekFetch } from '../cdek.js'

const BACKEND_URL = (process.env.BACKEND_URL ?? 'https://shop-koshekjewerly.onrender.com').replace(/\/$/, '')

function webhookUrl(): string {
  const secret = process.env.CDEK_WEBHOOK_SECRET
  return `${BACKEND_URL}/api/cdek/webhook${secret ? `?token=${encodeURIComponent(secret)}` : ''}`
}

async function main() {
  const cmd = process.argv[2] ?? 'list'

  if (cmd === 'list') {
    const data = await cdekFetch('GET', '/webhooks')
    console.log(JSON.stringify(data, null, 2))
    return
  }

  if (cmd === 'register') {
    const url = webhookUrl()
    console.log(`Регистрирую подписку ORDER_STATUS → ${url}`)
    const data = await cdekFetch('POST', '/webhooks', { url, type: 'ORDER_STATUS' })
    console.log('Готово:', JSON.stringify(data, null, 2))
    return
  }

  if (cmd === 'delete') {
    const uuid = process.argv[3]
    if (!uuid) { console.error('usage: ... delete <uuid>'); process.exit(1) }
    const data = await cdekFetch('DELETE', `/webhooks/${uuid}`).catch(() => null)
    console.log('Удалено:', uuid, data ? JSON.stringify(data) : '')
    return
  }

  console.log('usage: register-cdek-webhook.ts [list|register|delete <uuid>]')
}

main().catch(e => { console.error(e); process.exit(1) })
