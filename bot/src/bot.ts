import 'dotenv/config';
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { InputFile } from 'grammy';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';

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

const bot = new Bot(token);

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
const CHANNEL_USERNAME = process.env.TG_CHANNEL_USERNAME || 'ecl1psetest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// путь к файлу для хранения chat_id пользователей
const USER_CHAT_IDS_FILE = path.join(__dirname, '..', 'user-chat-ids.json');

// хранилище chat_id всех пользователей для рассылки
const userChatIds = new Set<string | number>();

// загружаем список chat_id из файла при запуске
function loadUserChatIds(): Set<string | number> {
  try {
    if (fs.existsSync(USER_CHAT_IDS_FILE)) {
      const data = fs.readFileSync(USER_CHAT_IDS_FILE, 'utf8');
      const ids = JSON.parse(data);
      if (Array.isArray(ids)) {
        const set = new Set<string | number>();
        ids.forEach(id => set.add(id));
        console.log(`[loadUserChatIds] загружено ${set.size} chat_id из файла`);
        return set;
      }
    }
  } catch (error: any) {
    console.warn('[loadUserChatIds] ошибка при загрузке файла:', error?.message);
  }
  return new Set<string | number>();
}

// сохраняем список chat_id в файл
function saveUserChatIds(set: Set<string | number>) {
  try {
    const ids = Array.from(set);
    fs.writeFileSync(USER_CHAT_IDS_FILE, JSON.stringify(ids, null, 2), 'utf8');
    console.log(`[saveUserChatIds] сохранено ${ids.length} chat_id в файл`);
  } catch (error: any) {
    console.error('[saveUserChatIds] ошибка при сохранении файла:', error?.message);
  }
}

// добавляем chat_id и сохраняем в файл
function addUserChatId(chatId: string | number) {
  if (!chatId) return
  const wasNew = !userChatIds.has(chatId)
  userChatIds.add(chatId)
  if (wasNew) {
    saveUserChatIds(userChatIds)
  }
}

// инициализируем список при запуске
const loadedIds = loadUserChatIds()
loadedIds.forEach(id => userChatIds.add(id))

// проверка что пользователь - менеджер
function isManager(chatId: string | number | undefined, username?: string): boolean {
  if (!chatId) {
    console.log('[isManager] chatId отсутствует')
    return false
  }
  
  console.log('[isManager] проверка:', { chatId, username, MANAGER_CHAT_ID, SUPPORT_USERNAME })
  
  // временный доступ для разработчика
  const TEMP_MANAGER_CHAT_ID = '8495144404'
  const TEMP_MANAGER_USERNAME = 'semyonp88'
  
  // проверка по временному chat_id
  if (String(chatId) === TEMP_MANAGER_CHAT_ID) {
    console.log('[isManager] доступ по временному chat_id (разработчик)')
    return true
  }
  
  // проверка по временному username
  if (username) {
    const userUsername = username.replace('@', '').toLowerCase()
    if (userUsername === TEMP_MANAGER_USERNAME) {
      console.log('[isManager] доступ по временному username (разработчик)')
      return true
    }
  }
  
  // проверка по chat_id (существующий менеджер)
  if (MANAGER_CHAT_ID) {
    const isMatch = String(chatId) === String(MANAGER_CHAT_ID)
    console.log('[isManager] проверка по chat_id:', isMatch, { chatId, MANAGER_CHAT_ID })
    if (isMatch) {
      return true
    }
  } else {
    console.log('[isManager] TG_MANAGER_CHAT_ID не задан')
  }
  
  // проверка по username (существующий менеджер)
  if (SUPPORT_USERNAME && username) {
    const supportUsername = SUPPORT_USERNAME.replace('@', '').toLowerCase()
    const userUsername = username.replace('@', '').toLowerCase()
    const isMatch = userUsername === supportUsername
    console.log('[isManager] проверка по username:', isMatch, { userUsername, supportUsername })
    if (isMatch) {
      return true
    }
  } else {
    console.log('[isManager] SUPPORT_USERNAME не задан или username отсутствует', { SUPPORT_USERNAME, username })
  }
  
  console.log('[isManager] доступ запрещен')
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

// хранилище данных рассылки (chatId -> { messageText, photoFileIds, needButton, buttonText })
type BroadcastData = {
  messageText: string
  photoFileIds?: string[]
  needButton?: boolean
  buttonText?: string
}
const broadcastData = new Map<string | number, BroadcastData>();

type ChannelPostDraft = {
  channel: string
  buttonText?: string
}
const channelPostDrafts = new Map<string | number, ChannelPostDraft>();

// временное хранилище для альбомов (media_group_id -> массив фото)
type MediaGroupCacheEntry = {
  chatId: string | number
  target: 'broadcast' | 'channel'
  items: Array<{ fileId: string, text?: string }>
}
const mediaGroupCache = new Map<string, MediaGroupCacheEntry>();

// таймеры для обработки альбомов (media_group_id -> timeout)
const mediaGroupTimers = new Map<string, NodeJS.Timeout>();

type SendMessageResult = { success: boolean; messageId?: number; error?: string }

// отправка сообщения через Telegram Bot API (для рассылки и канала)
async function sendMessage(
  chatId: string | number,
  text: string,
  photoFileIds?: string[],
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
    
    if (photoFileIds && photoFileIds.length > 0) {
      if (photoFileIds.length === 1) {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: photoFileIds[0],
            ...(hasText ? { caption: text } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {})
          })
        })
        
        const result = await response.json().catch(() => ({}))
        
        if (!response.ok || !result.ok) {
          console.error('Ошибка отправки фото с текстом:', result)
          return { success: false, error: result.description || 'telegram error' }
        }
        
        return { success: true, messageId: result.result?.message_id }
      } else {
        const media = photoFileIds.map((fileId, index) => ({
          type: 'photo',
          media: fileId,
          ...(index === 0 && hasText ? { caption: text } : {})
        }))
        
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            media
          })
        })
        
        const result = await response.json().catch(() => ({ ok: false }))
        
        if (!response.ok || !result.ok) {
          console.error('Ошибка отправки media group:', result)
          return { success: false, error: result.description || 'telegram error' }
        }
        
        if (replyMarkup && result.result && Array.isArray(result.result) && result.result.length > 0) {
          const targetIndex = hasText ? 0 : result.result.length - 1
          const targetMessage = result.result[targetIndex]
          const editResponse = await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: targetMessage.message_id,
              reply_markup: replyMarkup
            })
          })
          
          const editResult = await editResponse.json().catch(() => ({}))
          
          if (!editResponse.ok || !editResult.ok) {
            const description = editResult.description || ''
            if (description.includes('message is not modified')) {
              console.warn('[sendMessage] кнопка уже установлена, игнорируем message is not modified')
            } else {
              console.error('Ошибка добавления кнопки к media group:', editResult)
              return { success: false, error: description || 'telegram error' }
            }
          }
        }
        
        const lastMessageId = Array.isArray(result.result) && result.result.length > 0
          ? result.result[result.result.length - 1]?.message_id
          : undefined
        return { success: true, messageId: lastMessageId }
      }
    } else {
      if (!hasText) {
        return { success: false, error: 'empty_message' }
      }
      
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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
      
      const result = await sendMessage(userId, data.messageText, data.photoFileIds, buttonText, buttonUrl)
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
  } catch (error: any) {
    console.error('[startBroadcast] ошибка:', error?.message)
    await ctx.reply('❌ Ошибка при рассылке. Рассылка прервана.')
    broadcastData.delete(chatId)
  }
}

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
  if (wasCancelled) {
    
    // очищаем кэш альбомов и таймеры для этого менеджера
    // (в реальности media_group_id уникален, но на всякий случай очищаем все)
    for (const [groupId, timer] of mediaGroupTimers.entries()) {
      clearTimeout(timer)
      mediaGroupTimers.delete(groupId)
      mediaGroupCache.delete(groupId)
    }
    
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

async function sendChannelPostContent(channelUsername: string, messageText: string, photoFileIds?: string[], buttonText?: string) {
  try {
    const channel = channelUsername.replace('@', '')
    const miniappLink = await getMiniAppDeepLink()
    const finalButtonText = buttonText && buttonText.trim().length > 0
      ? buttonText.trim().slice(0, 64)
      : 'Открыть каталог 🛍️'
    const result = await sendMessage(
      `@${channel}`,
      messageText,
      photoFileIds,
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
  const example = CHANNEL_USERNAME ? `@${CHANNEL_USERNAME.replace('@', '')}` : '@channelname'
  await ctx.reply(`📢 Введи username канала, куда отправить пост: @channel \nИспользуй /cancel для отмены.`)
});

// создаем reply keyboard с кнопкой "Старт"
const startKeyboard = new Keyboard()
  .text('Старт')
  .resized();

// функция обработки команды /start (используется и для команды, и для кнопки)
async function handleStart(ctx: any) {
  // сохраняем chat_id пользователя для рассылки
  const chatId = ctx.from?.id
  if (chatId) {
    addUserChatId(chatId)
  }
  
  // проверяем параметры deep link (для возврата после оплаты)
  const startParam = ctx.match || ''
  
  if (startParam.includes('order_') && startParam.includes('_success')) {
    // успешная оплата
    const orderId = startParam.replace('order_', '').replace('_success', '')
    const kb = new InlineKeyboard().webApp('Открыть магазин 🛍️', WEBAPP_URL)
    await ctx.reply(
      `✅ <b>Оплата успешна!</b>\n\n` +
      `Ваш заказ <code>${orderId}</code> успешно оплачен.\n` +
      `Информация о заказе отправлена вам и менеджеру.\n\n` +
      `Спасибо за покупку! 💖`,
      { parse_mode: 'HTML', reply_markup: kb }
    )
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
  
  // показываем reply keyboard с кнопкой "Старт" (отдельным сообщением)
  // отправляем сообщение с клавиатурой, игнорируем ошибки если они есть
  try {
    await ctx.reply(' ', {
      reply_markup: startKeyboard
    });
  } catch (error: any) {
    // игнорируем ошибку - клавиатура не критична
    // ошибка может возникать из-за особенностей Telegram API, но функциональность работает
    console.warn('[handleStart] предупреждение при отправке reply keyboard:', error?.message || error);
  }
}

bot.command('start', handleStart);

bot.command('support', async (ctx) => {
  await ctx.reply(`написать менеджеру: https://t.me/${SUPPORT_USERNAME}`);
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
  const chatId = ctx.from?.id
  const username = ctx.from?.username
  
  // сохраняем chat_id пользователя
  if (chatId) {
    addUserChatId(chatId)
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
  
  // обработка кнопки "Старт" из reply keyboard
  if (ctx.message.text === 'Старт') {
    await handleStart(ctx)
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
    const mediaGroupId = ctx.message.media_group_id
    const contextAction = targetMode === 'broadcast' ? 'Рассылка' : 'Отправка'
    const contextGenitive = targetMode === 'broadcast' ? 'рассылки' : 'поста'
    const contextAccusative = targetMode === 'broadcast' ? 'рассылку' : 'пост'
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
    
    // обработка альбомов
    if (mediaGroupId && photos.length > 0) {
      const photoFileId = photos[photos.length - 1]?.file_id
      const messageText = ctx.message.caption || ''
      
      if (!mediaGroupCache.has(mediaGroupId)) {
        mediaGroupCache.set(mediaGroupId, { chatId, target: targetMode, items: [] })
      }
      
      const cache = mediaGroupCache.get(mediaGroupId)!
      cache.items.push({ fileId: photoFileId, text: messageText })
      cache.target = targetMode
      cache.chatId = chatId
      
      if (mediaGroupTimers.has(mediaGroupId)) {
        clearTimeout(mediaGroupTimers.get(mediaGroupId)!)
      }
      
      const timer = setTimeout(async () => {
        const cacheEntry = mediaGroupCache.get(mediaGroupId)
        mediaGroupTimers.delete(mediaGroupId)
        if (!cacheEntry) return
        
        const target = cacheEntry.target
        const targetChatId = cacheEntry.chatId as string | number
        const localAction = target === 'broadcast' ? 'Рассылка' : 'Отправка'
        const localGenitive = target === 'broadcast' ? 'рассылки' : 'поста'
        const localAccusative = target === 'broadcast' ? 'рассылку' : 'пост'
        const items = cacheEntry.items || []
        
        if (items.length > 0 && items.length <= 10) {
          const photoFileIds = items.map(p => p.fileId)
          const finalText = items[items.length - 1]?.text || ''
          
          await ctx.reply(`🔍 Проверяю альбом перед ${localGenitive}...`)
          const testResult = await sendMessage(targetChatId, finalText, photoFileIds)
          
          if (!testResult.success) {
            await ctx.reply(`❌ Ошибка при проверке альбома. ${localAction} отменена.\nПроверь текст/фото или используй /cancel.`)
            if (target === 'broadcast') waitingForBroadcast.add(targetChatId)
            mediaGroupCache.delete(mediaGroupId)
            return
          }
          
          mediaGroupCache.delete(mediaGroupId)
          
          if (target === 'broadcast') {
            const data: BroadcastData = {
              messageText: finalText,
              photoFileIds
            }
            broadcastData.set(targetChatId, data)
            waitingForBroadcast.delete(targetChatId)
            await askAboutButton(ctx, targetChatId, data)
          } else {
            const draft = channelPostDrafts.get(targetChatId)
            if (!draft) {
              await ctx.reply('❌ Канал не найден. Используй /channel_post заново.')
              waitingForChannelContent.delete(targetChatId)
              return
            }
            if (!draft.buttonText) {
              await ctx.reply('❌ Текст кнопки не найден. Введи его заново.')
              waitingForChannelContent.delete(targetChatId)
              waitingForChannelButtonText.add(targetChatId)
              return
            }
            const result = await sendChannelPostContent(draft.channel, finalText, photoFileIds, draft.buttonText)
            if (result.success) {
              waitingForChannelContent.delete(targetChatId)
              channelPostDrafts.delete(targetChatId)
              await ctx.reply(`✅ Пост отправлен в @${draft.channel}\nMessage ID: <code>${result.messageId}</code>`, { parse_mode: 'HTML' })
            } else {
              await ctx.reply(`❌ Ошибка отправки: <code>${result.error || 'unknown'}</code>\nОтредактируй пост и пришли снова или используй /cancel.`, { parse_mode: 'HTML' })
            }
          }
        } else if (items.length > 10) {
          await ctx.reply('❌ Максимум 10 фото в одном сообщении. Отправь меньше фото или используй /cancel.')
          if (target === 'broadcast') waitingForBroadcast.add(targetChatId)
          mediaGroupCache.delete(mediaGroupId)
        }
      }, 2000)
      
      mediaGroupTimers.set(mediaGroupId, timer)
      return
    }
    
    // одиночное сообщение
    const messageText = ctx.message.text || ctx.message.caption || ''
    
    if (!messageText && photos.length === 0) {
      await ctx.reply('❌ Сообщение пустое. Попробуй еще раз или используй /cancel.')
      if (targetMode === 'broadcast') {
        waitingForBroadcast.add(chatId)
      }
      return
    }
    
    const photoFileIds = photos.length > 0 
      ? [photos[photos.length - 1].file_id]
      : undefined
    
    await ctx.reply(`🔍 Проверяю сообщение перед ${contextGenitive}...`)
    const testResult = await sendMessage(chatId, messageText, photoFileIds)
    
    if (!testResult.success) {
      await handleFatalError(`❌ Ошибка при проверке сообщения. ${contextAction} отменена.\nПроверь текст/фото и попробуй еще раз или используй /cancel.`)
      return
    }
    
    if (targetMode === 'broadcast') {
      waitingForBroadcast.delete(chatId)
      const data: BroadcastData = {
        messageText,
        photoFileIds
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
      
      const result = await sendChannelPostContent(draft.channel, messageText, photoFileIds, draft.buttonText)
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
  
  // обычное сообщение
  await ctx.reply('используй /start чтобы открыть мини‑приложение')
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

// сразу делаем первый запрос при запуске
keepAlive();

console.log(`[keep-alive] настроен, интервал: ${KEEP_ALIVE_INTERVAL / 1000} секунд`);
console.log(`[keep-alive] URL бэкенда: ${BACKEND_URL}/health`);

// настраиваем команды бота (появятся в меню)
bot.api.setMyCommands([
  { command: 'start', description: 'Открыть каталог' }
]);

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

bot.start();


