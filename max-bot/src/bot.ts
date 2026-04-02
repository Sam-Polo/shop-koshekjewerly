import 'dotenv/config'
import { Bot, Keyboard } from '@maxhub/max-bot-api'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'
import express from 'express'

const token = process.env.MAX_BOT_TOKEN
if (!token) {
  console.error('❌ ОШИБКА: MAX_BOT_TOKEN не задан в переменных окружения!')
  throw new Error('env MAX_BOT_TOKEN is required')
}

const bot = new Bot(token)

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000'
const MANAGER_CHAT_ID = process.env.MAX_MANAGER_CHAT_ID
const MAX_API_BASE = 'https://platform-api.max.ru'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Хранилище chat_id пользователей для рассылки (отдельный файл от TG бота)
const USER_CHAT_IDS_FILE = path.join(__dirname, '..', 'user-chat-ids.json')
const userChatIds = new Set<string | number>()

function loadUserChatIds(): Set<string | number> {
  try {
    if (fs.existsSync(USER_CHAT_IDS_FILE)) {
      const data = fs.readFileSync(USER_CHAT_IDS_FILE, 'utf8')
      const ids = JSON.parse(data)
      if (Array.isArray(ids)) {
        const set = new Set<string | number>()
        ids.forEach(id => set.add(id))
        console.log(`[loadUserChatIds] загружено ${set.size} chat_id из файла`)
        return set
      }
    }
  } catch (error: any) {
    console.warn('[loadUserChatIds] ошибка при загрузке файла:', error?.message)
  }
  return new Set<string | number>()
}

function saveUserChatIds(set: Set<string | number>) {
  try {
    const ids = Array.from(set)
    fs.writeFileSync(USER_CHAT_IDS_FILE, JSON.stringify(ids, null, 2), 'utf8')
  } catch (error: any) {
    console.error('[saveUserChatIds] ошибка при сохранении файла:', error?.message)
  }
}

function addUserChatId(chatId: string | number) {
  if (!chatId) return
  const wasNew = !userChatIds.has(chatId)
  userChatIds.add(chatId)
  if (wasNew) saveUserChatIds(userChatIds)
}

// Инициализируем список при запуске
const loadedIds = loadUserChatIds()
loadedIds.forEach(id => userChatIds.add(id))

// Извлекаем числовой ID отправителя из контекста MAX SDK.
function getSenderId(ctx: any): string | number | undefined {
  return ctx.from?.id
    ?? ctx.update?.sender?.user_id
    ?? ctx.update?.message?.sender?.user_id
}

function isManager(chatId: string | number | undefined): boolean {
  if (!chatId) return false
  if (MANAGER_CHAT_ID && String(chatId) === String(MANAGER_CHAT_ID)) {
    return true
  }
  return false
}

// ───────────────────────────── Broadcast state ─────────────────────────────

// Шаг 1: ждём текст рассылки
const waitingForBroadcastText = new Set<string | number>()
// Шаг 2: ждём фото (после того как текст принят)
const waitingForBroadcastPhoto = new Set<string | number>()

type BroadcastData = {
  messageText: string
  photoToken?: string // токен фото из входящего сообщения, переиспользуется при рассылке
}
const broadcastData = new Map<string | number, BroadcastData>()

// ──────────────────────── Sending via MAX REST API ────────────────────────

async function sendMaxMessageDirect(
  userId: string | number,
  text: string,
  photoToken?: string
): Promise<boolean> {
  try {
    const body: any = { format: 'html' }
    if (text) body.text = text
    if (photoToken) {
      body.attachments = [{ type: 'image', payload: { token: photoToken } }]
    }

    const response = await fetch(`${MAX_API_BASE}/messages?user_id=${userId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token!
      },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      const err = await response.text()
      console.error(`[sendMaxMessageDirect] ошибка для userId=${userId}:`, err)
      return false
    }
    return true
  } catch (e: any) {
    console.error('[sendMaxMessageDirect] ошибка:', e?.message)
    return false
  }
}

// ─────────────────────────── Broadcast logic ─────────────────────────────

async function startBroadcast(ctx: any, chatId: string | number, data: BroadcastData) {
  try {
    await ctx.reply(`✅ Начинаю рассылку ${userChatIds.size} пользователям...`)

    let sent = 0
    let failed = 0

    for (const userId of userChatIds) {
      if (String(userId) === String(chatId)) continue
      const success = await sendMaxMessageDirect(userId, data.messageText, data.photoToken)
      if (success) { sent++ } else { failed++ }
      // Задержка, чтобы не превысить rate limit MAX (30 RPS)
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    broadcastData.delete(chatId)
    await ctx.reply(`✅ Рассылка завершена:\nОтправлено: ${sent}\nОшибок: ${failed}`)
  } catch (error: any) {
    console.error('[startBroadcast] ошибка:', error?.message)
    await ctx.reply('❌ Ошибка при рассылке. Рассылка прервана.')
    broadcastData.delete(chatId)
  }
}

// ─────────────────────────── /start handler ──────────────────────────────

async function handleStart(ctx: any, startParam: string = '') {
  const chatId = getSenderId(ctx)
  if (chatId) addUserChatId(chatId)

  if (startParam.includes('order_') && startParam.includes('_success')) {
    const orderId = startParam.replace('order_', '').replace('_success', '')
    await ctx.reply(
      `✅ <b>Оплата успешна!</b>\n\n` +
      `Ваш заказ <code>${orderId}</code> успешно оплачен.\n` +
      `Информация о заказе отправлена вам и менеджеру.\n\n` +
      `Спасибо за покупку! 💖`,
      { format: 'html' }
    )
    return
  }

  if (startParam.includes('order_') && startParam.includes('_fail')) {
    const orderId = startParam.replace('order_', '').replace('_fail', '')
    await ctx.reply(
      `❌ <b>Оплата не завершена</b>\n\n` +
      `К сожалению, произошла ошибка при оплате заказа <code>${orderId}</code>.\n\n` +
      `Попробуйте оформить заказ еще раз.`,
      { format: 'html' }
    )
    return
  }

  // Обычное приветствие
  await ctx.reply('Добро пожаловать в KOSHEK JEWERLY 🐾\n\nОткрой мини-приложение через кнопку меню внизу.')
}

// ─────────────────────────────── Commands ────────────────────────────────

bot.command('start', async (ctx) => {
  const startParam: string = (ctx as any).match || ''
  await handleStart(ctx, startParam)
})

// bot_started — событие первого открытия бота или перехода по deep link
bot.on('bot_started', async (ctx) => {
  const startParam: string =
    (ctx as any).update?.payload ??
    (ctx as any).startPayload ??
    ''
  await handleStart(ctx, startParam)
})

function getHelpMessage(): string {
  return (
    '📚 Доступные команды бота:\n\n' +
    '/start — приветствие\n' +
    '/help — показать список команд\n\n' +
    '🔐 Команды только для админа:\n' +
    '/broadcast — рассылка (текст + фото)\n' +
    '/users — показать количество пользователей\n' +
    '/cancel — отменить текущую операцию'
  )
}

bot.command('help', async (ctx) => {
  const chatId = getSenderId(ctx)
  if (!isManager(chatId)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }
  await ctx.reply(getHelpMessage())
})

bot.command('users', async (ctx) => {
  const chatId = getSenderId(ctx)
  if (!isManager(chatId)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }
  await ctx.reply(`👥 Всего пользователей: <b>${userChatIds.size}</b>`, { format: 'html' })
})

bot.command('broadcast', async (ctx) => {
  const chatId = getSenderId(ctx)
  if (!isManager(chatId)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }
  waitingForBroadcastText.add(chatId!)
  await ctx.reply('📢 Режим рассылки активирован.\n\nШаг 1: пришли текст рассылки.\nИспользуй /cancel для отмены.')
})

// Служебная команда для получения своего chat_id
bot.command('myid', async (ctx) => {
  const chatId = getSenderId(ctx)
  await ctx.reply(`Твой chat_id в MAX: <code>${chatId}</code>`, { format: 'html' })
})

bot.command('cancel', async (ctx) => {
  const chatId = getSenderId(ctx)
  const wasCancelled =
    waitingForBroadcastText.has(chatId!) ||
    waitingForBroadcastPhoto.has(chatId!)
  if (wasCancelled) {
    waitingForBroadcastText.delete(chatId!)
    waitingForBroadcastPhoto.delete(chatId!)
    broadcastData.delete(chatId!)
    await ctx.reply('❌ Действие отменено.')
  }
})

// ──────────────────────── Callback query handlers ─────────────────────────

bot.action('broadcast_photo_yes', async (ctx) => {
  const chatId = getSenderId(ctx)
  if (!isManager(chatId)) {
    await ctx.answerOnCallback({ notification: '⛔ У вас нет доступа' })
    return
  }
  const data = chatId ? broadcastData.get(chatId) : undefined
  if (!data) {
    await ctx.answerOnCallback({ notification: '❌ Данные рассылки не найдены' })
    return
  }
  waitingForBroadcastPhoto.add(chatId!)
  await ctx.answerOnCallback({ notification: '✅ Пришли фото' })
  await ctx.editMessage({ text: '📷 Пришли фото для рассылки.\nИспользуй /cancel для отмены.' })
})

bot.action('broadcast_photo_no', async (ctx) => {
  const chatId = getSenderId(ctx)
  if (!isManager(chatId)) {
    await ctx.answerOnCallback({ notification: '⛔ У вас нет доступа' })
    return
  }
  const data = chatId ? broadcastData.get(chatId) : undefined
  if (!data) {
    await ctx.answerOnCallback({ notification: '❌ Данные рассылки не найдены' })
    return
  }
  await ctx.answerOnCallback({ notification: '✅ Начинаю рассылку без фото' })
  await ctx.editMessage({ text: '✅ Начинаю рассылку без фото...' })
  await startBroadcast(ctx, chatId!, data)
})

bot.action('broadcast_cancel', async (ctx) => {
  const chatId = getSenderId(ctx)
  waitingForBroadcastText.delete(chatId!)
  waitingForBroadcastPhoto.delete(chatId!)
  broadcastData.delete(chatId!)
  await ctx.answerOnCallback({ notification: '❌ Рассылка отменена' })
  await ctx.editMessage({ text: '❌ Рассылка отменена.' })
})

// ─────────────────────────── Message handler ─────────────────────────────

bot.on('message_created', async (ctx) => {
  const chatId = getSenderId(ctx)

  if (chatId) addUserChatId(chatId)

  // Получаем текст сообщения (MAX API: message.body.text)
  const text: string =
    (ctx as any).message?.body?.text ||
    (ctx as any).message?.text ||
    ''

  // Шаг 2: ждём фото для рассылки
  if (chatId && waitingForBroadcastPhoto.has(chatId) && isManager(chatId)) {
    const attachments: any[] = (ctx as any).message?.body?.attachments ?? []
    const photoAtt = attachments.find((a: any) => a.type === 'image' && a.payload?.token)

    if (!photoAtt) {
      await ctx.reply('❌ Нужно прислать фото. Попробуй ещё раз или используй /cancel.')
      return
    }

    const data = broadcastData.get(chatId)
    if (!data) {
      await ctx.reply('❌ Ошибка: данные рассылки не найдены. Используй /cancel и начни заново.')
      waitingForBroadcastPhoto.delete(chatId)
      return
    }

    data.photoToken = photoAtt.payload.token
    broadcastData.set(chatId, data)
    waitingForBroadcastPhoto.delete(chatId)
    await startBroadcast(ctx, chatId, data)
    return
  }

  // Шаг 1: ждём текст рассылки
  if (chatId && waitingForBroadcastText.has(chatId) && isManager(chatId)) {
    if (!text.trim()) {
      await ctx.reply('❌ Текст рассылки не может быть пустым.')
      return
    }
    waitingForBroadcastText.delete(chatId)
    const data: BroadcastData = { messageText: text.trim() }
    broadcastData.set(chatId, data)

    const keyboard = Keyboard.inlineKeyboard([
      [
        Keyboard.button.callback('📷 Да, добавить фото', 'broadcast_photo_yes'),
        Keyboard.button.callback('❌ Нет, без фото', 'broadcast_photo_no'),
      ],
      [Keyboard.button.callback('⛔ Отменить рассылку', 'broadcast_cancel')]
    ])
    await ctx.reply('❓ Добавить фото к рассылке?', { attachments: [keyboard] })
    return
  }

  // Обычное сообщение
  await ctx.reply('используй /start чтобы открыть мини‑приложение')
})

// ──────────────────────────── Keep-alive ─────────────────────────────────

async function keepAlive() {
  try {
    const startTime = Date.now()
    const response = await fetch(`${BACKEND_URL}/health`, {
      headers: { 'User-Agent': 'MaxBot-KeepAlive' }
    })
    const ms = Date.now() - startTime
    const ts = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
    if (response.ok) {
      console.log(`[keep-alive] бэкенд активен | ${ts} | ${ms}мс`)
    } else {
      console.warn(`[keep-alive] бэкенд вернул ошибку: ${response.status} | ${ts}`)
    }
  } catch (e: any) {
    const ts = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })
    console.warn(`[keep-alive] ошибка: ${e?.message} | ${ts}`)
  }
}

setInterval(keepAlive, 5 * 60 * 1000)
keepAlive()

// ───────────────────────── Bot commands menu ─────────────────────────────

bot.api.setMyCommands([
  { name: 'start', description: 'Открыть каталог' },
  { name: 'help', description: 'Список команд (админ)' }
]).catch((e: any) => {
  console.warn('[bot] ошибка при установке команд:', e?.message)
})

// ─────────────────────── Start: polling or webhook ───────────────────────

const useWebhook = process.env.MAX_USE_WEBHOOK === 'true'

if (useWebhook) {
  const webhookUrl = process.env.MAX_WEBHOOK_URL
  if (!webhookUrl) {
    throw new Error('MAX_WEBHOOK_URL обязателен при MAX_USE_WEBHOOK=true')
  }

  const app = express()
  app.use(express.json())

  app.post('/webhook', async (req, res) => {
    try {
      await (bot as any).handleUpdate(req.body)
      res.status(200).json({ ok: true })
    } catch (error: any) {
      console.error('[webhook] ошибка обработки:', error?.message)
      res.status(200).json({ ok: true })
    }
  })

  const port = Number(process.env.PORT ?? 3001)
  app.listen(port, async () => {
    console.log(`[max-bot] webhook сервер запущен на порту ${port}`)

    try {
      const response = await fetch(`${MAX_API_BASE}/subscriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token!
        },
        body: JSON.stringify({ url: webhookUrl })
      })
      if (response.ok) {
        console.log(`[max-bot] webhook зарегистрирован: ${webhookUrl}`)
      } else {
        const err = await response.text()
        console.error('[max-bot] ошибка регистрации webhook:', err)
      }
    } catch (e: any) {
      console.error('[max-bot] не удалось зарегистрировать webhook:', e?.message)
    }
  })
} else {
  console.log('[max-bot] запуск в режиме long polling...')
  bot.start()
}
