import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { InputFile } from 'grammy';
import path from 'path';
import { fileURLToPath } from 'url';
import { setDefaultResultOrder } from 'node:dns';
import { tgFetch, proxyDispatcher } from './proxy.js'
import { sendAlert } from './alerts.js';
import { userChatIds, loadUserChatIds, saveUserChatIds, addUserChatId } from './user-store.js'

// предпочитаем ipv4: помогает избежать зависаний на ipv6 у некоторых хостингов
setDefaultResultOrder('ipv4first');

const token = process.env.TG_BOT_TOKEN;
if (!token) {
  console.error('❌ ОШИБКА: TG_BOT_TOKEN не задан в переменных окружения!')
  console.error('Проверь файл .env в директории /opt/bot/bot/')
  throw new Error('env TG_BOT_TOKEN is required')
}

// проверяем что токен не пустой и имеет правильный формат
if (token.length < 20) {
  console.error('❌ ОШИБКА: TG_BOT_TOKEN слишком короткий, возможно неверный токен!')
  console.error(`Текущий токен (первые 10 символов): ${token.substring(0, 10)}...`)
  throw new Error('invalid TG_BOT_TOKEN')
}

console.log(`[bot] токен загружен, длина: ${token.length} символов`)

const bot = new Bot(token, proxyDispatcher ? {
  client: {
    baseFetchConfig: { dispatcher: proxyDispatcher } as any
  }
} : undefined);

const BOT_START_TIME = Math.floor(Date.now() / 1000)

// Пропускаем апдейты старше 5 минут до старта — предотвращает зависания из-за бэклога
// после рестарта (старые CDEK-ссылки, тестовые сообщения и т.п. не обрабатываются)
bot.use(async (ctx, next) => {
  const date = (ctx.message ?? ctx.channelPost ?? ctx.editedMessage)?.date
  if (date && date < BOT_START_TIME - 300) return
  await next()
})

const WEBAPP_URL = process.env.TG_WEBAPP_URL ?? 'http://localhost:5173';
// URL бэкенда для keep-alive
// если не указан BACKEND_URL, пытаемся определить из окружения или используем дефолт
const BACKEND_URL = process.env.BACKEND_URL || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://shop-koshekjewerly.onrender.com' // дефолтный URL для продакшена
    : 'http://localhost:4000'); // дефолт для локальной разработки
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME;
const MANAGER_CHAT_ID = process.env.TG_MANAGER_CHAT_ID;
// канал для публикации поста с мини-приложением

// ID группы обсуждений канала заказов (отличается от ID самого канала)
// если задан — /track и CDEK-детект работают только в этой группе
const ORDERS_DISCUSSION_GROUP_ID = process.env.TG_ORDERS_DISCUSSION_GROUP_ID?.trim();


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// инициализируем список при запуске
loadUserChatIds()

// проверка что пользователь - менеджер
function isManager(chatId: string | number | undefined, username?: string): boolean {
  if (!chatId) return false

  // временный доступ для разработчика
  const TEMP_MANAGER_CHAT_ID = '8495144404'
  const TEMP_MANAGER_USERNAME = 'semyonp88'
  if (String(chatId) === TEMP_MANAGER_CHAT_ID) return true
  if (username && username.replace('@', '').toLowerCase() === TEMP_MANAGER_USERNAME) return true

  if (MANAGER_CHAT_ID && String(chatId) === String(MANAGER_CHAT_ID)) return true

  if (SUPPORT_USERNAME && username) {
    const supportUsername = SUPPORT_USERNAME.replace('@', '').toLowerCase()
    if (username.replace('@', '').toLowerCase() === supportUsername) return true
  }

  return false
}

// состояние ожидания сообщения для рассылки (chat_id менеджера -> true)
const waitingForBroadcast = new Set<string | number>();

// состояние ожидания ответа на вопрос про кнопку
const waitingForButtonQuestion = new Set<string | number>();

// состояние ожидания текста кнопки
const waitingForButtonText = new Set<string | number>();

// состояние ожидания username канала, текста кнопки и контента
const waitingForChannelPost = new Set<string | number>();
const waitingForChannelButtonText = new Set<string | number>();
const waitingForChannelContent = new Set<string | number>();

// кэш авто-форвардов постов заказов из канала: "chatId:messageId" → orderId
// нужен чтобы находить orderId по message_thread_id в комментариях
const threadOrderCache = new Map<string, string>()
const THREAD_CACHE_MAX = 200

type MediaAttachment = {
  type: 'photo' | 'video'
  fileId: string
}

// хранилище данных рассылки (chatId -> { messageText, media, needButton, buttonText })
type BroadcastData = {
  messageText: string
  media?: MediaAttachment
  needButton?: boolean
  buttonText?: string
}
const broadcastData = new Map<string | number, BroadcastData>();

type ChannelPostDraft = {
  channel: string
  buttonText?: string
}
const channelPostDrafts = new Map<string | number, ChannelPostDraft>();

// ─── /test_order state ───────────────────────────────────────────────────────
type TestOrderStep = 'fullName' | 'phone' | 'city' | 'address' | 'comments'
type TestOrderDraft = {
  step: TestOrderStep
  fullName?: string
  phone?: string
  city?: string
  address?: string
}
const testOrderDrafts = new Map<string | number, TestOrderDraft>()

function normalizePhone(phone: string): string {
  if (!phone) return phone
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+7${digits}`
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return `+7${digits.slice(1)}`
  return phone
}

type SendMessageResult = { success: boolean; messageId?: number; error?: string }

// отправка сообщения через Telegram Bot API (для рассылки и канала)
async function sendMessage(
  chatId: string | number,
  text: string,
  media?: MediaAttachment,
  buttonText?: string,
  buttonUrl?: string,
  buttonMode: 'web_app' | 'url' = 'web_app'
): Promise<SendMessageResult> {
  try {
    const hasText = typeof text === 'string' && text.trim().length > 0
    
    const replyMarkup = (buttonText && buttonUrl) ? {
      inline_keyboard: [[
        buttonMode === 'web_app'
          ? { text: buttonText, web_app: { url: buttonUrl } }
          : { text: buttonText, url: buttonUrl }
      ]]
    } : undefined
    
    if (media) {
      const payload: Record<string, any> = {
        chat_id: chatId,
        ...(hasText ? { caption: text } : {}),
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      }
      
      let endpoint = ''
      if (media.type === 'photo') {
        endpoint = 'sendPhoto'
        payload.photo = media.fileId
      } else {
        endpoint = 'sendVideo'
        payload.video = media.fileId
      }
      
      const response = await tgFetch(`https://api.telegram.org/bot${token}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      
      const result = await response.json().catch(() => ({}))
      
      if (!response.ok || !result.ok) {
        console.error(`Ошибка отправки ${media.type}:`, result)
        return { success: false, error: result.description || 'telegram error' }
      }
      
      return { success: true, messageId: result.result?.message_id }
    } else {
      if (!hasText) {
        return { success: false, error: 'empty_message' }
      }
      
      const response = await tgFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {})
        })
      })
      
      const result = await response.json().catch(() => ({}))
      
      if (!response.ok || !result.ok) {
        console.error('Ошибка отправки текста:', result)
        return { success: false, error: result.description || 'telegram error' }
      }
      
      return { success: true, messageId: result.result?.message_id }
    }
  } catch (e: any) {
    console.error('ошибка отправки сообщения:', e?.message)
    return { success: false, error: e?.message || 'unknown error' }
  }
}

// функция для вопроса про кнопку
async function askAboutButton(ctx: any, chatId: string | number, data: BroadcastData) {
  waitingForButtonQuestion.add(chatId)
  const keyboard = new InlineKeyboard()
    .text('✅ Да, добавить', 'broadcast_button_yes')
    .text('❌ Нет, без кнопки', 'broadcast_button_no')
    .row()
    .text('⛔ Отменить рассылку', 'broadcast_cancel')
  
  await ctx.reply('❓ Добавить кнопку с ссылкой на миниапку?', {
    reply_markup: keyboard
  })
}

// функция для начала рассылки
async function startBroadcast(ctx: any, chatId: string | number, data: BroadcastData) {
  try {
    const buttonText = data.needButton && data.buttonText ? data.buttonText : undefined
    const buttonUrl = data.needButton && data.buttonText ? WEBAPP_URL : undefined
    
    await ctx.reply(`✅ Начинаю рассылку ${userChatIds.size} пользователям...`)
    
    // отправляем всем пользователям
    let sent = 0
    let failed = 0
    
    for (const userId of userChatIds) {
      // пропускаем самого менеджера
      if (String(userId) === String(chatId)) continue
      
      const result = await sendMessage(userId, data.messageText, data.media, buttonText, buttonUrl)
      if (result.success) {
        sent++
      } else {
        failed++
      }
      
      // небольшая задержка чтобы не получить rate limit
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    
    // очищаем данные рассылки
    broadcastData.delete(chatId)
    
    await ctx.reply(`✅ Рассылка завершена:\nОтправлено: ${sent}\nОшибок: ${failed}`)

    if (failed > 0 && failed > sent) {
      sendAlert(`Рассылка завершена с большим числом ошибок: отправлено ${sent}, ошибок ${failed}`, { tag: 'broadcast', level: 'moderate', hint: 'больше половины получателей не получили сообщение', code: 'BROADCAST_HIGH_FAILURE_RATE' }).catch(() => {})
    }
  } catch (error: any) {
    console.error('[startBroadcast] ошибка:', error?.message)
    sendAlert(`Рассылка упала: ${error?.message}`, { tag: 'broadcast', level: 'high', hint: 'рассылка прервана из-за необработанной ошибки', code: 'BROADCAST_FATAL_ERROR' }).catch(() => {})
    await ctx.reply('❌ Ошибка при рассылке. Рассылка прервана.')
    broadcastData.delete(chatId)
  }
}

// ctx.reply с fallback: если reply_parameters указывает на удалённое сообщение → plain reply
async function replyFallback(ctx: any, text: string, extra: Record<string, any>): Promise<void> {
  try {
    await ctx.reply(text, extra)
  } catch {
    try { await ctx.reply(text) } catch {}
  }
}

// отправляет трек покупателю через бэкенд и отвечает менеджеру о результате
async function handleSendTrack(ctx: any, orderId: string, trackingUrl: string): Promise<void> {
  const replyExtra = ctx.message?.message_id
    ? { reply_parameters: { message_id: ctx.message.message_id } }
    : {}
  const abortCtrl = new AbortController()
  const abortTimer = setTimeout(() => abortCtrl.abort(), 12_000)
  try {
    const resp = await fetch(`${BACKEND_URL}/api/orders/${orderId}/send-tracking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ trackingUrl }),
      signal: abortCtrl.signal
    })
    const respData = await resp.json().catch(() => ({})) as any
    clearTimeout(abortTimer)

    if (resp.status === 409) {
      await replyFallback(ctx, `⚠️ Трек по заказу ${orderId} уже был отправлен покупателю ранее.`, replyExtra)
      return
    }

    if (respData.ok) {
      await replyFallback(ctx, `✅ Трек отправлен покупателю по заказу ${orderId}.`, replyExtra)
    } else {
      let errMsg: string
      if (respData.error === 'no_customer_chat_id') {
        errMsg = 'покупатель не запускал бота — chat_id не сохранён. Свяжитесь по телефону.'
      } else if (respData.error === 'order not found') {
        errMsg = 'заказ не найден'
      } else if (/chat not found|bot was blocked|user is deactivated/i.test(respData.error || '')) {
        errMsg = 'покупатель заблокировал бота или не начинал диалог. Свяжитесь по телефону.'
      } else {
        errMsg = respData.error || 'неизвестная ошибка'
      }
      await replyFallback(ctx, `❌ Не удалось отправить трек по заказу ${orderId}.\nПричина: ${errMsg}`, replyExtra)
    }
  } catch (e: any) {
    clearTimeout(abortTimer)
    const msg = e?.name === 'AbortError'
      ? 'сервер не отвечает (таймаут). Попробуйте через минуту, когда бэкенд проснётся.'
      : (e?.message || 'неизвестная ошибка')
    await replyFallback(ctx, `❌ Ошибка связи с сервером: ${msg}`, replyExtra)
  }
}

// /track — отправка трека покупателю. Два варианта:
//   1) /track ORD-XXXXX https://cdek.ru/...  — явное указание (личка или группа)
//   2) /track https://cdek.ru/...             — ответом на пост заказа (ORD берётся из текста поста)
bot.command('track', async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username

  // в приватном чате — только менеджер
  // в группах — только если это наша discussion group (TG_ORDERS_DISCUSSION_GROUP_ID)
  const isOurDiscussionGroup = ctx.chat?.type !== 'private' &&
    (!ORDERS_DISCUSSION_GROUP_ID || String(ctx.chat?.id) === ORDERS_DISCUSSION_GROUP_ID)
  if (!isOurDiscussionGroup && !isManager(chatId, username)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }

  const args = (ctx.match || '').trim()

  // вариант 1: /track ORD-XXXXX https://...
  const fullMatch = args.match(/^(ORD-[\w-]+)\s+(https?:\/\/\S+)/)
  if (fullMatch) {
    const orderId = fullMatch[1]
    const trackingUrl = fullMatch[2].replace(/[.,;!?)]+$/, '')
    await handleSendTrack(ctx, orderId, trackingUrl)
    return
  }

  // вариант 2: /track https://... отправленное как reply на пост заказа
  const urlOnlyMatch = args.match(/^(https?:\/\/\S+)$/)
  if (urlOnlyMatch && ctx.message?.reply_to_message) {
    const repliedText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || ''
    const orderIdMatch = repliedText.match(/ORD-[\w-]+/)
    if (orderIdMatch) {
      const trackingUrl = urlOnlyMatch[1].replace(/[.,;!?)]+$/, '')
      await handleSendTrack(ctx, orderIdMatch[0], trackingUrl)
      return
    }
    await ctx.reply('❌ Номер заказа ORD-XXXXX не найден в тексте поста. Используй: /track ORD-XXXXX https://cdek.ru/...')
    return
  }

  await ctx.reply(
    '❌ Формат команды:\n' +
    '/track ORD-XXXXX https://cdek.ru/...\n\n' +
    'или ответом на пост заказа:\n' +
    '/track https://cdek.ru/...'
  )
})

// команда рассылки
bot.command('broadcast', async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username
  
  console.log('[broadcast] запрос от:', { chatId, username, MANAGER_CHAT_ID, SUPPORT_USERNAME })
  
  if (!isManager(chatId, username)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }
  
  waitingForBroadcast.add(chatId!)
  await ctx.reply('📢 Режим рассылки активирован. Жду сообщение ...\n\nИспользуй /cancel для отмены.')
});

// отмена рассылки
bot.command('cancel', async (ctx) => {
  const chatId = ctx.from?.id
  let wasCancelled = false
  if (waitingForBroadcast.has(chatId!) || waitingForButtonQuestion.has(chatId!) || waitingForButtonText.has(chatId!)) {
    waitingForBroadcast.delete(chatId!)
    waitingForButtonQuestion.delete(chatId!)
    waitingForButtonText.delete(chatId!)
    broadcastData.delete(chatId!)
    wasCancelled = true
  }
  if (waitingForChannelPost.has(chatId!)) {
    waitingForChannelPost.delete(chatId!)
    channelPostDrafts.delete(chatId!)
    wasCancelled = true
  }
  if (waitingForChannelButtonText.has(chatId!)) {
    waitingForChannelButtonText.delete(chatId!)
    channelPostDrafts.delete(chatId!)
    wasCancelled = true
  }
  if (waitingForChannelContent.has(chatId!)) {
    waitingForChannelContent.delete(chatId!)
    channelPostDrafts.delete(chatId!)
    wasCancelled = true
  }
  if (testOrderDrafts.has(chatId!)) {
    testOrderDrafts.delete(chatId!)
    wasCancelled = true
  }
  if (wasCancelled) {
    await ctx.reply('❌ Действие отменено.')
  }
});

// команда для подсчета пользователей (только для менеджера)
bot.command('users', async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username
  
  if (!isManager(chatId, username)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }
  
  const usersCount = userChatIds.size
  await ctx.reply(`👥 Всего пользователей: <b>${usersCount}</b>`, { parse_mode: 'HTML' })
});

bot.command('test_order', async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username
  if (!isManager(chatId, username)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }
  testOrderDrafts.set(chatId!, { step: 'fullName' })
  await ctx.reply('🧪 Тестовый заказ\n\nШаг 1/5: введи ФИО покупателя.\nИспользуй /cancel для отмены.')
})

let cachedMiniAppLink: string | null = null

async function getMiniAppDeepLink(): Promise<string> {
  if (cachedMiniAppLink) {
    return cachedMiniAppLink
  }
  const botInfo = await bot.api.getMe()
  const botUsername = botInfo.username
  cachedMiniAppLink = `https://t.me/${botUsername}/miniapp`
  return cachedMiniAppLink
}

async function sendChannelPostContent(channelUsername: string, messageText: string, media?: MediaAttachment, buttonText?: string) {
  try {
    const channel = channelUsername.replace('@', '')
    const miniappLink = await getMiniAppDeepLink()
    const finalButtonText = buttonText && buttonText.trim().length > 0
      ? buttonText.trim().slice(0, 64)
      : 'Открыть каталог 🛍️'
    const result = await sendMessage(
      `@${channel}`,
      messageText,
      media,
      finalButtonText,
      miniappLink,
      'url'
    )
    if (!result.success) {
      return { success: false, error: result.error || 'telegram error' }
    }
    console.log(`[sendChannelPost] сообщение отправлено в канал @${channel}, message_id: ${result.messageId}`)
    return { success: true, messageId: result.messageId }
  } catch (error: any) {
    console.error('[sendChannelPost] ошибка отправки в канал:', error?.message || error)
    return { success: false, error: error?.message || 'unknown error' }
  }
}

// команда для отправки поста в канал (только для менеджера)
bot.command('channel_post', async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username
  
  if (!isManager(chatId, username)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }
  
  waitingForChannelPost.add(chatId!)
  await ctx.reply(`📢 Введи username канала, куда отправить пост: @channel \nИспользуй /cancel для отмены.`)
});


// функция обработки команды /start (используется и для команды, и для кнопки)
async function handleStart(ctx: any) {
  // сохраняем chat_id пользователя для рассылки
  const chatId = ctx.from?.id
  if (chatId) {
    addUserChatId(chatId)
  }

  // WebApp-кнопки работают только в личке. В группах/каналах — молчим.
  if (ctx.chat?.type !== 'private') return

  // проверяем параметры deep link (для возврата после оплаты)
  const startParam = ctx.match || ''

  if (startParam.includes('order_') && startParam.includes('_success')) {
    // успешная оплата — подтверждаем и пробуем переотправить уведомление с деталями заказа
    const invId = startParam.replace('order_', '').replace('_success', '')
    const fullOrderId = `ORD-${invId}`
    const kb = new InlineKeyboard().webApp('Открыть магазин 🛍️', WEBAPP_URL)

    await ctx.reply(
      `✅ <b>Оплата успешна!</b>\n\n` +
      `Ваш заказ <code>${fullOrderId}</code> успешно оплачен.\n` +
      `Ниже придёт сообщение с деталями заказа. 💖`,
      { parse_mode: 'HTML', reply_markup: kb }
    )

    // пробуем (пере)отправить уведомление с деталями заказа через бэкенд
    if (chatId && BACKEND_URL && process.env.TG_BOT_TOKEN) {
      fetch(`${BACKEND_URL}/api/orders/${fullOrderId}/resend-notification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TG_BOT_TOKEN}`,
        },
        body: JSON.stringify({ chatId }),
      }).then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as any
          // 404 = заказ пока в pending или не в памяти (нормально для Render sleep)
          if (r.status !== 404 && r.status !== 400) {
            console.warn(`[start] resend-notification: HTTP ${r.status}`, body?.error)
          }
        }
      }).catch(e => {
        console.warn('[start] resend-notification: ошибка сети', e?.message)
      })
    }
    return
  }
  
  if (startParam.includes('order_') && startParam.includes('_fail')) {
    // неудачная оплата
    const orderId = startParam.replace('order_', '').replace('_fail', '')
    const kb = new InlineKeyboard().webApp('Попробовать снова 🔄', WEBAPP_URL)
    await ctx.reply(
      `❌ <b>Оплата не завершена</b>\n\n` +
      `К сожалению, произошла ошибка при оплате заказа <code>${orderId}</code>.\n\n` +
      `Попробуйте оформить заказ еще раз.`,
      { parse_mode: 'HTML', reply_markup: kb }
    )
    return
  }
  
  // обычное приветствие
  const kb = new InlineKeyboard().webApp('KOSHEK JEWERLY🐾', WEBAPP_URL);
  const photoPath = path.join(__dirname, '..', 'assets', 'bot-greeting.jpg');
  await ctx.replyWithPhoto(new InputFile(photoPath), {
    caption: 'Нажми на кнопку, чтоб перейти в каталог 👇🏽',
    reply_markup: kb,
  });
  
}

bot.command('start', handleStart);

// диагностическая команда — не зависит ни от чего, не может упасть
bot.command('ping', async (ctx) => {
  const chatId = ctx.from?.id
  const chatType = ctx.chat?.type
  await ctx.reply(`pong | chat=${chatId} type=${chatType} ts=${Date.now()}`)
})

bot.command('support', async (ctx) => {
  await ctx.reply(`написать менеджеру: https://t.me/${SUPPORT_USERNAME}`);
});

bot.command('myorders', async (ctx) => {
  const chatId = ctx.from?.id
  if (!chatId) return

  let orders: Array<{ orderId: string; createdAt: string; status: string; total: number }> = []
  const abortCtrl = new AbortController()
  const abortTimer = setTimeout(() => abortCtrl.abort(), 12_000)
  try {
    const resp = await fetch(`${BACKEND_URL}/api/orders/my?chatId=${chatId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: abortCtrl.signal,
    })
    if (resp.ok) {
      const data = await resp.json() as { orders: typeof orders }
      orders = data.orders ?? []
    }
    clearTimeout(abortTimer)
  } catch (e: any) {
    clearTimeout(abortTimer)
    const msg = e?.name === 'AbortError'
      ? '⚠️ Сервер не отвечает (таймаут). Попробуйте через минуту.'
      : '⚠️ Не удалось загрузить заказы. Попробуйте позже.'
    await ctx.reply(msg)
    return
  }

  if (orders.length === 0) {
    await ctx.reply('У вас пока нет заказов.')
    return
  }

  const STATUS_LABEL: Record<string, string> = {
    pending: '⏳ Ожидает',
    paid: '✅ Оплачен',
    processing: '🔧 В обработке',
    shipped: '🚚 Отправлен',
    delivered: '📦 Доставлен',
    cancelled: '❌ Отменён',
  }

  const lines = orders.map((o, i) => {
    const date = o.createdAt ? new Date(o.createdAt).toLocaleDateString('ru-RU') : '—'
    const status = STATUS_LABEL[o.status] ?? o.status
    return `${i + 1}. ${o.orderId}\n   📅 ${date}  💰 ${o.total} ₽\n   ${status}`
  })

  await ctx.reply(`📦 Ваши заказы (последние ${orders.length}):\n\n${lines.join('\n\n')}`)
})

function getHelpMessage(): string {
  return (
    '📚 Доступные команды бота:\n\n' +
    '/start — открыть каталог\n' +
    '/myorders — мои последние заказы\n' +
    '/support — ссылка на менеджера\n' +
    '/help — показать список команд\n\n' +
    '🔐 Команды только для админа:\n' +
    '/broadcast — запустить рассылку\n' +
    '/channel_post — отправить пост в канал\n' +
    '/users — показать количество пользователей\n' +
    '/test_order — тестовый заказ без оплаты\n' +
    '/cancel — отменить текущую операцию'
  )
}

bot.command('help', async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username

  if (!isManager(chatId, username)) {
    await ctx.reply('❌ У вас нет доступа к этой команде.')
    return
  }

  await ctx.reply(getHelpMessage())
});

// обработка callback_query (кнопки)
bot.callbackQuery(['broadcast_button_yes', 'broadcast_button_no', 'broadcast_cancel'], async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username
  
  if (!isManager(chatId, username)) {
    await ctx.answerCallbackQuery('⛔ У вас нет доступа')
    return
  }
  
  const data = chatId ? broadcastData.get(chatId) : undefined
  if (!data) {
    await ctx.answerCallbackQuery('❌ Данные рассылки не найдены')
    await ctx.reply('❌ Ошибка: данные рассылки не найдены. Используй /cancel и начни заново.')
    return
  }
  
  if (ctx.callbackQuery.data === 'broadcast_button_yes') {
    data.needButton = true
    broadcastData.set(chatId!, data)
    waitingForButtonQuestion.delete(chatId!)
    waitingForButtonText.add(chatId!)
    await ctx.answerCallbackQuery('✅ Кнопка будет добавлена')
    await ctx.editMessageText('✅ Кнопка будет добавлена.\n\n📝 Введи текст для кнопки (например: "Открыть каталог" или "Перейти в магазин").\nИспользуй /cancel для отмены.')
    return
  } else if (ctx.callbackQuery.data === 'broadcast_button_no') {
    data.needButton = false
    broadcastData.set(chatId!, data)
    waitingForButtonQuestion.delete(chatId!)
    await ctx.answerCallbackQuery('✅ Рассылка без кнопки')
    await ctx.editMessageText('✅ Начинаю рассылку без кнопки...')
    await startBroadcast(ctx, chatId!, data)
    return
  } else if (ctx.callbackQuery.data === 'broadcast_cancel') {
    waitingForButtonQuestion.delete(chatId!)
    waitingForButtonText.delete(chatId!)
    broadcastData.delete(chatId!)
    await ctx.answerCallbackQuery('❌ Рассылка отменена')
    await ctx.editMessageText('❌ Рассылка отменена.')
    return
  }
});

// обработка сообщений (рассылка или обычное сообщение)
bot.on('message', async (ctx) => {
  // игнорируем сообщения из канала алертов (бот там участник, не должен отвечать)
  const errorChannelId = process.env.ERROR_CHANNEL_CHAT_ID?.trim()
  if (errorChannelId && ctx.chat?.id.toString() === errorChannelId) return

  // GroupAnonymousBot (1087968824) — так выглядят сообщения администраторов канала
  // когда они пишут в discussion group от имени канала (анонимно).
  // Обрабатываем только CDEK-ссылки, не сохраняем как обычного пользователя.
  const isGroupAnonymousBot = ctx.from?.id === 1087968824

  const chatId = ctx.from?.id
  const username = ctx.from?.username

  // сохраняем chat_id только реальных пользователей
  if (chatId && !isGroupAnonymousBot) {
    addUserChatId(chatId)
  }

  // кэшируем авто-форварды постов заказов (channel → discussion group)
  // это нужно чтобы по message_thread_id находить orderId без явного reply
  if ((ctx.message as any).is_automatic_forward) {
    const postText = ctx.message.text || ctx.message.caption || ''
    const orderIdInPost = postText.match(/ORD-[\w-]+/)
    if (orderIdInPost && ctx.chat?.id) {
      threadOrderCache.set(`${ctx.chat.id}:${ctx.message.message_id}`, orderIdInPost[0])
      if (threadOrderCache.size > THREAD_CACHE_MAX) {
        const oldestKey = threadOrderCache.keys().next().value
        if (oldestKey) threadOrderCache.delete(oldestKey)
      }
    }
  }

  // ── CDEK-трек из комментария под постом заказа ──────────────────────────
  // в нашей discussion group (TG_ORDERS_DISCUSSION_GROUP_ID) — без проверки isManager
  // если переменная не задана — разрешаем в любой группе (обратная совместимость)
  // GroupAnonymousBot = admin канала, постящий анонимно — тоже пропускаем
  const isOurDiscussionGroupForCdek = ctx.chat?.type !== 'private' &&
    (!ORDERS_DISCUSSION_GROUP_ID || String(ctx.chat?.id) === ORDERS_DISCUSSION_GROUP_ID)
  const isAuthorizedForTrack = isOurDiscussionGroupForCdek || isManager(chatId, username)
  if (isAuthorizedForTrack) {
    const trackMsgText = ctx.message.text || ''
    const cdekLinkMatch = trackMsgText.match(/https?:\/\/(?:www\.)?cdek\.ru\/\S+/)

    if (cdekLinkMatch) {
      let orderId: string | undefined

      // вариант 1: явный reply на пост заказа с ORD-XXXXX в тексте
      if (ctx.message.reply_to_message) {
        const repliedText = ctx.message.reply_to_message.text || ctx.message.reply_to_message.caption || ''
        const m = repliedText.match(/ORD-[\w-]+/)
        if (m) orderId = m[0]
      }

      // вариант 2: комментарий в треде через "Комментировать" (без явного reply)
      if (!orderId && ctx.message.message_thread_id && ctx.chat?.id) {
        orderId = threadOrderCache.get(`${ctx.chat.id}:${ctx.message.message_thread_id}`)
      }

      if (orderId) {
        const trackingUrl = cdekLinkMatch[0].replace(/[.,;!?)]+$/, '')
        await handleSendTrack(ctx, orderId, trackingUrl)
        return
      }
    }
  }

  // GroupAnonymousBot обрабатываем только для CDEK-детекта выше, дальше не идём
  if (isGroupAnonymousBot) return

  // ── /test_order шаги ────────────────────────────────────────────────────
  if (chatId && testOrderDrafts.has(chatId) && isManager(chatId, username)) {
    const draft = testOrderDrafts.get(chatId)!
    const text = ctx.message.text?.trim() || ''
    if (!text) { await ctx.reply('❌ Пустой ввод, попробуй ещё раз.'); return }

    if (draft.step === 'fullName') {
      draft.fullName = text
      draft.step = 'phone'
      testOrderDrafts.set(chatId, draft)
      await ctx.reply('Шаг 2/5: введи номер телефона.')
      return
    }
    if (draft.step === 'phone') {
      draft.phone = normalizePhone(text)
      draft.step = 'city'
      testOrderDrafts.set(chatId, draft)
      await ctx.reply(`✅ Телефон: ${draft.phone}\n\nШаг 3/5: введи город.`)
      return
    }
    if (draft.step === 'city') {
      draft.city = text
      draft.step = 'address'
      testOrderDrafts.set(chatId, draft)
      await ctx.reply('Шаг 4/5: введи пункт СДЭК или адрес доставки.')
      return
    }
    if (draft.step === 'address') {
      draft.address = text
      draft.step = 'comments'
      testOrderDrafts.set(chatId, draft)
      await ctx.reply('Шаг 5/5: введи комментарий к заказу (или "-" если нет).')
      return
    }
    if (draft.step === 'comments') {
      const comments = text === '-' ? '' : text
      testOrderDrafts.delete(chatId)
      const managerChatId = process.env.TG_MANAGER_CHAT_ID
      if (!managerChatId) {
        await ctx.reply('❌ TG_MANAGER_CHAT_ID не задан.')
        return
      }
      const msg =
        `🧪 <b>Тестовый заказ</b>\n\n` +
        `Покупатель: ${draft.fullName}\n` +
        `Телефон: ${draft.phone}\n` +
        `Город: ${draft.city}\n` +
        `Адрес/СДЭК: ${draft.address}\n` +
        (comments ? `Комментарий: ${comments}\n` : '') +
        `\nTG: @${username || 'неизвестно'}`
      await ctx.api.sendMessage(Number(managerChatId), msg, { parse_mode: 'HTML' })
      await ctx.reply('✅ Тестовый заказ отправлен менеджеру.')
      return
    }
  }

  // fallback для /help, если middleware команд не сработал
  const rawText = ctx.message.text?.trim() || ''
  const isHelpCommand = /^\/help(@[a-zA-Z0-9_]+)?$/i.test(rawText)
  if (isHelpCommand) {
    if (!isManager(chatId, username)) {
      await ctx.reply('❌ У вас нет доступа к этой команде.')
      return
    }
    await ctx.reply(getHelpMessage())
    return
  }

  // ожидание username канала для поста
  if (chatId && waitingForChannelPost.has(chatId) && isManager(chatId, username)) {
    const rawInput = ctx.message.text?.trim()
    if (!rawInput) {
      await ctx.reply('❌ Нужно прислать username канала в формате @channel или ссылку t.me')
      return
    }
    
    let normalized = rawInput.trim()
    if (normalized.toLowerCase().startsWith('https://t.me/')) {
      normalized = normalized.slice('https://t.me/'.length)
    }
    normalized = normalized.replace('@', '').trim()
    
    if (!normalized || !/^[a-zA-Z0-9_]{5,32}$/.test(normalized)) {
      await ctx.reply('❌ Неверный username. Используй только латиницу/цифры/подчёркивание, минимум 5 символов.')
      return
    }
    
    waitingForChannelPost.delete(chatId)
    const channel = normalized
    channelPostDrafts.set(chatId, { channel })
    waitingForChannelButtonText.add(chatId)
    
    await ctx.reply(
      `✅ Канал @${channel} сохранен.\n` +
      `Теперь введи текст КНОПКИ (до 64 символов). Используй /cancel для отмены.`
    )
    return
  }
  
  // ожидание текста кнопки для поста в канал
  if (chatId && waitingForChannelButtonText.has(chatId) && isManager(chatId, username)) {
    const buttonText = ctx.message.text?.trim()
    if (!buttonText) {
      await ctx.reply('❌ Текст кнопки не может быть пустым. Введи текст или используй /cancel.')
      return
    }
    if (buttonText.length > 64) {
      await ctx.reply('❌ Текст кнопки должен быть короче 64 символов. Попробуй еще раз.')
      return
    }
    
    const draft = channelPostDrafts.get(chatId)
    if (!draft) {
      waitingForChannelButtonText.delete(chatId)
      await ctx.reply('❌ Канал не найден. Используй /channel_post заново.')
      return
    }
    
    draft.buttonText = buttonText
    channelPostDrafts.set(chatId, draft)
    waitingForChannelButtonText.delete(chatId)
    waitingForChannelContent.add(chatId)
    
    await ctx.reply(
      '✅ Кнопка сохранена.\nПришли текст/фото поста (можно альбом до 10 фото). ' +
      'К посту автоматически добавлю эту кнопку. Используй /cancel для отмены.'
    )
    return
  }
  
  // обработка текста кнопки
  if (chatId && waitingForButtonText.has(chatId) && isManager(chatId, username)) {
    const buttonText = ctx.message.text?.trim()
    
    if (!buttonText || buttonText.length === 0) {
      await ctx.reply('❌ Текст кнопки не может быть пустым. Введи текст для кнопки или используй /cancel для отмены.')
      return
    }
    
    if (buttonText.length > 64) {
      await ctx.reply('❌ Текст кнопки слишком длинный (максимум 64 символа). Введи более короткий текст или используй /cancel для отмены.')
      return
    }
    
    const data = broadcastData.get(chatId)
    if (!data) {
      await ctx.reply('❌ Ошибка: данные рассылки не найдены. Используй /cancel и начни заново.')
      waitingForButtonText.delete(chatId)
      return
    }
    
    data.buttonText = buttonText
    broadcastData.set(chatId, data)
    waitingForButtonText.delete(chatId)
    
    // начинаем рассылку с кнопкой
    await startBroadcast(ctx, chatId, data)
    return
  }
  
  // если менеджер готовит рассылку или пост в канал
  const isManagerUser = chatId && isManager(chatId, username)
  const targetMode: 'broadcast' | 'channel' | null = isManagerUser
    ? (waitingForBroadcast.has(chatId!) ? 'broadcast'
      : waitingForChannelContent.has(chatId!) ? 'channel'
      : null)
    : null
  
  if (chatId && targetMode) {
    const photos = ctx.message.photo || []
    const video = ctx.message.video
    const mediaGroupId = ctx.message.media_group_id
    const contextAction = targetMode === 'broadcast' ? 'Рассылка' : 'Отправка'
    const contextGenitive = targetMode === 'broadcast' ? 'рассылки' : 'поста'
    const channelDraft = targetMode === 'channel' ? channelPostDrafts.get(chatId) : null
    
    if (targetMode === 'channel' && !channelDraft) {
      waitingForChannelContent.delete(chatId)
      await ctx.reply('❌ Канал не выбран. Используй /channel_post заново.')
      return
    }
    
    const handleFatalError = async (message: string) => {
      await ctx.reply(message)
      if (targetMode === 'broadcast') {
        waitingForBroadcast.add(chatId)
      }
    }
    
    // запрет альбомов
    if (mediaGroupId) {
      const errorText = targetMode === 'broadcast'
        ? '❌ Рассылка поддерживает только одно фото или одно видео. Отправь новое сообщение без альбома.'
        : '❌ Пост в канал поддерживает только одно фото или одно видео. Отправь новое сообщение без альбома.'
      await ctx.reply(errorText)
      return
    }
    
    // одиночное сообщение
    const messageText = ctx.message.text || ctx.message.caption || ''
    
    if (!messageText && photos.length === 0 && !video) {
      await ctx.reply('❌ Сообщение пустое. Попробуй еще раз или используй /cancel.')
      if (targetMode === 'broadcast') {
        waitingForBroadcast.add(chatId)
      }
      return
    }
    
    let mediaAttachment: MediaAttachment | undefined
    if (video) {
      mediaAttachment = { type: 'video', fileId: video.file_id }
    } else if (photos.length > 0) {
      mediaAttachment = { type: 'photo', fileId: photos[photos.length - 1].file_id }
    }
    
    await ctx.reply(`🔍 Проверяю сообщение перед ${contextGenitive}...`)
    const testResult = await sendMessage(chatId, messageText, mediaAttachment)
    
    if (!testResult.success) {
      await handleFatalError(`❌ Ошибка при проверке сообщения. ${contextAction} отменена.\nПроверь текст/фото и попробуй еще раз или используй /cancel.`)
      return
    }
    
    if (targetMode === 'broadcast') {
      waitingForBroadcast.delete(chatId)
      const data: BroadcastData = {
        messageText,
        media: mediaAttachment
      }
      broadcastData.set(chatId, data)
      await askAboutButton(ctx, chatId, data)
    } else {
      const draft = channelPostDrafts.get(chatId)
      if (!draft) {
        waitingForChannelContent.delete(chatId)
        await ctx.reply('❌ Канал не найден. Используй /channel_post заново.')
        return
      }
      if (!draft.buttonText) {
        waitingForChannelContent.delete(chatId)
        waitingForChannelButtonText.add(chatId)
        await ctx.reply('❌ Сначала введи текст кнопки для поста.')
        return
      }
      
      const result = await sendChannelPostContent(draft.channel, messageText, mediaAttachment, draft.buttonText)
      if (result.success) {
        waitingForChannelContent.delete(chatId)
        channelPostDrafts.delete(chatId)
        await ctx.reply(`✅ Пост отправлен в @${draft.channel}\nMessage ID: <code>${result.messageId}</code>`, { parse_mode: 'HTML' })
      } else {
        await ctx.reply(`❌ Ошибка отправки: <code>${result.error || 'unknown'}</code>\nПопробуй снова или используй /cancel.`, { parse_mode: 'HTML' })
      }
    }
    return
  }
  
  // обычное сообщение — только в личке, в группах/каналах молчим
  if (ctx.chat?.type === 'private') {
    await ctx.reply('используй /start чтобы открыть мини‑приложение')
  }
});

// keep-alive для бэкенда (чтобы не засыпал на Render)
async function keepAlive() {
  try {
    const healthUrl = `${BACKEND_URL}/health`;
    const startTime = Date.now();
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'TelegramBot-KeepAlive' }
    });
    const responseTime = Date.now() - startTime;
    const timestamp = new Date().toLocaleString('ru-RU', { 
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    if (response.ok) {
      console.log(`[keep-alive] бэкенд активен | ${timestamp} | время ответа: ${responseTime}мс`);
    } else {
      console.warn(`[keep-alive] бэкенд вернул ошибку: ${response.status} | ${timestamp}`);
    }
  } catch (error: any) {
    const timestamp = new Date().toLocaleString('ru-RU', { 
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    console.warn(`[keep-alive] ошибка при проверке бэкенда: ${error?.message} | ${timestamp}`);
  }
}

// запускаем keep-alive каждые 5 минут (300000 мс)
// это разбудит бэкенд если он спит и не даст ему заснуть
const KEEP_ALIVE_INTERVAL = 5 * 60 * 1000; // 5 минут
setInterval(keepAlive, KEEP_ALIVE_INTERVAL);
keepAlive();

console.log(`[keep-alive] настроен, интервал: ${KEEP_ALIVE_INTERVAL / 1000} секунд`);
console.log(`[keep-alive] URL бэкенда: ${BACKEND_URL}/health`);

// ── Синхронизация пользователей из мини-аппа ──────────────────────────────
// Каждые 10 минут забираем новых пользователей из бэкенда и сохраняем в файл

async function syncPendingUsers() {
  try {
    const secret = process.env.BOT_API_SECRET
    const url = `${BACKEND_URL}/api/pending-users?platform=tg${secret ? `&secret=${secret}` : ''}`
    const resp = await fetch(url)
    if (!resp.ok) return
    const data = await resp.json() as { ids: number[] }
    if (!Array.isArray(data.ids) || data.ids.length === 0) return
    let added = 0
    for (const id of data.ids) {
      if (!userChatIds.has(id)) { userChatIds.add(id); added++ }
    }
    if (added > 0) {
      saveUserChatIds()
      console.log(`[sync-users] добавлено ${added} новых пользователей из мини-аппа`)
    }
  } catch (e: any) {
    console.warn('[sync-users] ошибка:', e?.message)
  }
}

setInterval(syncPendingUsers, 10 * 60 * 1000)
syncPendingUsers()

// настраиваем команды бота (появятся в меню)
bot.api.setMyCommands([
  { command: 'start', description: 'Открыть каталог' },
  { command: 'myorders', description: 'Мои последние заказы' },
  { command: 'support', description: 'Написать менеджеру' },
  { command: 'help', description: 'Список команд (админ)' }
]).then(() => {
  console.log('[bot] команды меню установлены')
}).catch((error: any) => {
  // ошибка установки команд не должна ронять бота
  console.warn('[bot] не удалось установить команды меню:', error?.message || error)
});

// настраиваем кнопку меню "Open" для открытия мини-приложения
// эта кнопка будет отображаться в списке чатов и внутри диалога с ботом
// без указания chat_id устанавливается кнопка по умолчанию для всех чатов
bot.api.setChatMenuButton({
  menu_button: {
    type: 'web_app',
    text: 'Открыть каталог',
    web_app: { url: WEBAPP_URL }
  }
}).then(() => {
  console.log(`[bot] кнопка меню "Open" настроена, URL: ${WEBAPP_URL}`);
}).catch((error: any) => {
  console.warn('[bot] ошибка при настройке кнопки меню:', error?.message || error);
});

// глобальный error handler grammy.
// БЕЗ него любая неперехваченная ошибка хендлера приводит к "No error handler was set! Stopping bot",
// после чего long-polling останавливается и бот перестаёт отвечать ВСЕМ — пока pm2 не перезапустит.
// Транзиентные ошибки TG API (403 blocked / 400 chat not found / сетевые) — нормальная часть жизни бота,
// логируем их и продолжаем. Всё остальное логируем как ошибку, но процесс не валим.
bot.catch((err) => {
  const e = err.error as any
  const updateId = err.ctx?.update?.update_id
  const userId = err.ctx?.from?.id
  const description: string | undefined = e?.description
  const errorCode: number | undefined = e?.error_code
  const method: string | undefined = e?.method

  // Telegram API «юзер недоступен» — не наша вина, не шумим в error.log
  const isUnreachable =
    (errorCode === 403 && /blocked|deactivated|kicked/i.test(description ?? '')) ||
    (errorCode === 400 && /chat not found/i.test(description ?? ''))

  if (isUnreachable) {
    console.warn(`[bot.catch] юзер ${userId} недоступен (${method}: ${description}) — апдейт ${updateId} пропущен`)
    return
  }

  // сетевые/прокси-ошибки — то же самое: логируем как warn, бот продолжает работать
  const cause = e?.cause || e
  const code: string | undefined = cause?.code || cause?.name
  if (code && /ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|SocketError|ConnectTimeout|fetch failed/i.test(String(code) + ' ' + String(cause?.message ?? ''))) {
    console.warn(`[bot.catch] сетевая ошибка в апдейте ${updateId} (${code}): ${cause?.message ?? e?.message}`)
    return
  }

  // всё прочее — реальная ошибка, в error.log, но НЕ роняем бота
  const errText = e?.description ?? e?.message ?? String(e)
  console.error(`[bot.catch] необработанная ошибка в апдейте ${updateId} от юзера ${userId}:`, e)
  sendAlert(
    `Необработанная ошибка в апдейте ${updateId ?? '?'} от юзера ${userId ?? '?'}: ${errText}`,
    { tag: 'bot.catch', level: 'high', hint: 'бот получил апдейт, который не удалось обработать — проверьте логи', code: 'BOT_UPDATE_HANDLER_ERROR' }
  ).catch(() => {})
  // пробуем сообщить пользователю об ошибке (чтобы не молчать)
  err.ctx?.reply?.(`⚙️ Внутренняя ошибка: ${errText}`).catch(() => {})
})

// глобальные обработчики необработанных ошибок — лучше знать, чем молчать
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
  sendAlert(`uncaughtException: ${err?.message ?? String(err)}`, { tag: 'process', level: 'critical', hint: 'непойманное исключение — процесс мог упасть или нестабилен', code: 'UNCAUGHT_EXCEPTION' }).catch(() => {})
})

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error('[unhandledRejection]', reason)
  sendAlert(`unhandledRejection: ${msg}`, { tag: 'process', level: 'critical', hint: 'необработанный Promise — возможна скрытая ошибка или утечка памяти', code: 'UNHANDLED_REJECTION' }).catch(() => {})
})

// стартовый self-check — в канал, чтобы видеть каждый перезапуск и состояние конфига
async function sendStartupAlert() {
  if (process.env.FEATURE_DEBUG_ALERTS !== 'true') return
  try {
    const pkg = await import('../package.json', { with: { type: 'json' } }).then(m => m.default)
    const botVersion: string = (pkg as any).version ?? '?'
    const proxyStatus = process.env.TG_PROXY_URL
      ? (process.env.TG_PROXY_URL_BACKUP ? 'primary+backup' : 'primary only')
      : 'нет (прямые запросы)'
    const channelOk = !!process.env.ERROR_CHANNEL_CHAT_ID
    const startMsg =
      `✅ [bot] перезапущен v${botVersion} | ${new Date().toISOString()}\n` +
      `Прокси: ${proxyStatus}\n` +
      `Канал ошибок: ${channelOk ? 'задан' : '⚠️ не задан'}\n` +
      `Юзеров в файле: ${userChatIds.size}\n` +
      `BACKEND_URL: ${BACKEND_URL}`
    await sendAlert(startMsg, { tag: 'startup', level: 'info' })

    if (!channelOk && MANAGER_CHAT_ID) {
      await bot.api.sendMessage(Number(MANAGER_CHAT_ID),
        '⚠️ Внимание!\n\n' +
        'Чат для уведомлений об ошибках не настроен в боте. ' +
        'Если что-то пойдёт не так, вы не получите автоматические уведомления.\n\n' +
        'Что делать: попросите разработчика добавить ERROR_CHANNEL_CHAT_ID в настройки бота.'
      ).catch(() => {})
    }
  } catch (e: any) {
    console.warn('[startup-alert] не удалось отправить:', e?.message)
  }
}

sendStartupAlert()

bot.start()


