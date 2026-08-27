/**
 * Управление подпиской CDEK webhook (ручная операция).
 *
 *   npx tsx src/scripts/register-cdek-webhook.ts list            # показать текущие подписки
 *   npx tsx src/scripts/register-cdek-webhook.ts register        # подписаться на ORDER_STATUS
 *   npx tsx src/scripts/register-cdek-webhook.ts delete <uuid>   # удалить подписку
 *
 * URL подписки строит cdek-webhook-watchdog.ts — там же, где его проверяет сторож,
 * чтобы ручная регистрация и автоматическая проверка не разъехались (например
 * по токену: подписка с чужим токеном молча получает 403 на каждый вебхук).
 *
 * Аккаунт CDEK тот же, что у бота → словит и Тильдины заказы.
 */

import 'dotenv/config'
import { cdekFetch } from '../cdek.js'
import { cdekWebhookUrl, listCdekWebhooks, registerCdekWebhook } from '../cdek-webhook-watchdog.js'

async function main() {
  const cmd = process.argv[2] ?? 'list'

  if (cmd === 'list') {
    console.log(JSON.stringify(await listCdekWebhooks(), null, 2))
    return
  }

  if (cmd === 'register') {
    console.log(`Регистрирую подписку ORDER_STATUS → ${cdekWebhookUrl()}`)
    const uuid = await registerCdekWebhook()
    console.log('Готово, uuid:', uuid)
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
