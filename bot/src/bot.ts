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

// временное хранилище для альбомов (media_group_id -> массив фото)
const mediaGroupCache = new Map<string, Array<{ fileId: string, text?: string }>>();

// таймеры для обработки альбомов (media_group_id -> timeout)
const mediaGroupTimers = new Map<string, NodeJS.Timeout>();

// экранирование специальных символов для MarkdownV2
function escapeMarkdownV2(text: string): string {
  // символы, которые нужно экранировать в MarkdownV2
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']
  let result = text
  for (const char of specialChars) {
    // экранируем только неэкранированные символы
    const regex = new RegExp(`(^|[^\\\\])${char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')
    result = result.replace(regex, `$1\\${char}`)
  }
  return result
}

// преобразование обычного Markdown в Telegram MarkdownV2
function convertToMarkdownV2(text: string): { success: boolean; text?: string; error?: string } {
  try {
    if (!text) {
      return { success: true, text: '' }
    }
    
    let result = text
    const placeholders: Array<{ placeholder: string; replacement: string }> = []
    let placeholderIndex = 0
    
    // сохраняем блоки кода (```...```) - не трогаем их содержимое
    result = result.replace(/```([\s\S]*?)```/g, (match) => {
      const placeholder = `\u0001CODEBLOCK${placeholderIndex}\u0001`
      placeholders.push({ placeholder, replacement: match })
      placeholderIndex++
      return placeholder
    })
    
    // сохраняем inline код (`...`) - не трогаем его содержимое
    result = result.replace(/`([^`\n]+)`/g, (match) => {
      const placeholder = `\u0001CODE${placeholderIndex}\u0001`
      placeholders.push({ placeholder, replacement: match })
      placeholderIndex++
      return placeholder
    })
    
    // преобразуем форматирование:
    // **жирный** → *жирный* (MarkdownV2 использует одну звездочку)
    result = result.replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    
    // __курсив__ → _курсив_ (MarkdownV2 использует одно подчеркивание)
    result = result.replace(/__([^_\n]+)__/g, '_$1_')
    
    // ~~перечеркнутый~~ → ~перечеркнутый~
    result = result.replace(/~~([^~\n]+)~~/g, '~$1~')
    
    // ||скрытый текст|| остается как есть (это уже правильный синтаксис MarkdownV2)
    
    // сохраняем все форматированные части, чтобы не экранировать их содержимое
    const formattedParts: Array<{ placeholder: string; replacement: string }> = []
    let formattedIndex = 0
    
    // сохраняем жирный текст (*...*)
    result = result.replace(/\*([^*\n]+)\*/g, (match) => {
      const placeholder = `\u0001BOLD${formattedIndex}\u0001`
      formattedParts.push({ placeholder, replacement: match })
      formattedIndex++
      return placeholder
    })
    
    // сохраняем курсив (_..._)
    result = result.replace(/_([^_\n]+)_/g, (match) => {
      const placeholder = `\u0001ITALIC${formattedIndex}\u0001`
      formattedParts.push({ placeholder, replacement: match })
      formattedIndex++
      return placeholder
    })
    
    // сохраняем перечеркнутый (~...~)
    result = result.replace(/~([^~\n]+)~/g, (match) => {
      const placeholder = `\u0001STRIKE${formattedIndex}\u0001`
      formattedParts.push({ placeholder, replacement: match })
      formattedIndex++
      return placeholder
    })
    
    // сохраняем скрытый текст (||...||)
    result = result.replace(/\|\|([^|\n]+)\|\|/g, (match) => {
      const placeholder = `\u0001SPOILER${formattedIndex}\u0001`
      formattedParts.push({ placeholder, replacement: match })
      formattedIndex++
      return placeholder
    })
    
    // экранируем специальные символы в оставшемся тексте
    result = escapeMarkdownV2(result)
    
    // возвращаем форматированные части обратно
    for (const { placeholder, replacement } of formattedParts.reverse()) {
      result = result.replace(placeholder, replacement)
    }
    
    // возвращаем блоки кода обратно (они уже правильно отформатированы)
    for (const { placeholder, replacement } of placeholders.reverse()) {
      result = result.replace(placeholder, replacement)
    }
    
    return { success: true, text: result }
  } catch (error: any) {
    return { success: false, error: error?.message || 'Ошибка преобразования форматирования' }
  }
}

// валидация MarkdownV2 форматирования через тестовую отправку
async function validateMarkdownV2(chatId: string | number, formattedText: string): Promise<{ valid: boolean; error?: string }> {
  try {
    // пробуем отправить тестовое сообщение самому себе для проверки форматирования
    const testResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formattedText,
        parse_mode: 'MarkdownV2'
      })
    })
    
    const result = await testResponse.json()
    
    if (!result.ok) {
      return { valid: false, error: result.description || 'Неверное форматирование MarkdownV2' }
    }
    
    // удаляем тестовое сообщение
    if (result.result?.message_id) {
      await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: result.result.message_id
        })
      }).catch(() => {}) // игнорируем ошибки удаления
    }
    
    return { valid: true }
  } catch (error: any) {
    return { valid: false, error: error?.message || 'Ошибка валидации форматирования' }
  }
}

// отправка сообщения через Telegram Bot API (для рассылки)
async function sendMessage(chatId: string | number, text: string, photoFileIds?: string[]): Promise<boolean> {
  try {
    // преобразуем форматирование в MarkdownV2
    const converted = convertToMarkdownV2(text)
    if (!converted.success || !converted.text) {
      console.error('Ошибка преобразования форматирования:', converted.error)
      return false
    }
    
    const formattedText = converted.text
    
    if (photoFileIds && photoFileIds.length > 0) {
      if (photoFileIds.length === 1) {
        // отправка одного фото
        const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: photoFileIds[0],
            caption: formattedText,
            parse_mode: 'MarkdownV2'
          })
        })
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          console.error('Ошибка отправки фото с текстом:', errorData)
          return false
        }
        
        return true
      } else {
        // отправка нескольких фото через media group (2-10 фото)
        // текст может быть только в caption последнего фото
        const media = photoFileIds.map((fileId, index) => ({
          type: 'photo',
          media: fileId,
          ...(index === photoFileIds.length - 1 && formattedText ? { caption: formattedText, parse_mode: 'MarkdownV2' } : {})
        }))
        
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            media: media
          })
        })
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          console.error('Ошибка отправки media group:', errorData)
          return false
        }
        
        return true
      }
    } else {
      // отправка текста
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: formattedText,
          parse_mode: 'MarkdownV2'
        })
      })
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.error('Ошибка отправки текста:', errorData)
        return false
      }
      
      return true
    }
  } catch (e: any) {
    console.error('ошибка отправки сообщения:', e?.message)
    return false
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
  if (waitingForBroadcast.has(chatId!)) {
    waitingForBroadcast.delete(chatId!)
    
    // очищаем кэш альбомов и таймеры для этого менеджера
    // (в реальности media_group_id уникален, но на всякий случай очищаем все)
    for (const [groupId, timer] of mediaGroupTimers.entries()) {
      clearTimeout(timer)
      mediaGroupTimers.delete(groupId)
      mediaGroupCache.delete(groupId)
    }
    
    await ctx.reply('❌ Рассылка отменена.')
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

// функция отправки сообщения в канал с кнопкой для открытия мини-приложения
async function sendChannelPost(channelUsername: string): Promise<{ success: boolean; messageId?: number; error?: string }> {
  try {
    // убираем @ если есть
    const channel = channelUsername.replace('@', '')
    
    // для каналов WebApp кнопки не поддерживаются, используем URL кнопку
    // получаем username бота для создания deep link мини-приложения
    const botInfo = await bot.api.getMe()
    const botUsername = botInfo.username
    
    // используем специальный deep link для мини-приложения (формат: t.me/botname/miniapp)
    // это откроет мини-приложение внутри Telegram, а не в браузере
    const miniappLink = `https://t.me/${botUsername}/miniapp`
    
    // создаем клавиатуру с URL кнопкой
    const kb = new InlineKeyboard().url('Открыть каталог 🛍️', miniappLink)
    
    // текст сообщения
    const messageText = `🛍️ <b>KOSHEK JEWERLY</b>\n\n` +
      `Добро пожаловать в наш каталог украшений!\n\n` +
      `Нажмите на кнопку ниже, чтобы открыть каталог и выбрать украшения. 💖`
    
    // отправляем сообщение в канал
    const result = await bot.api.sendMessage(`@${channel}`, messageText, {
      parse_mode: 'HTML',
      reply_markup: kb
    })
    
    console.log(`[sendChannelPost] сообщение отправлено в канал @${channel}, message_id: ${result.message_id}`)
    return { success: true, messageId: result.message_id }
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
  
  await ctx.reply('📢 Отправляю пост в канал...')
  
  const result = await sendChannelPost(CHANNEL_USERNAME)
  
  if (result.success) {
    await ctx.reply(`✅ Пост успешно отправлен в канал @${CHANNEL_USERNAME.replace('@', '')}\n\n` +
      `Message ID: <code>${result.messageId}</code>\n\n` +
      `Теперь закрепи это сообщение в канале, чтобы кнопка всегда была видна.`,
      { parse_mode: 'HTML' })
  } else {
    await ctx.reply(`❌ Ошибка отправки поста в канал:\n<code>${result.error}</code>\n\n` +
      `Проверь:\n` +
      `1. Бот добавлен в канал как администратор\n` +
      `2. У бота есть права на отправку сообщений\n` +
      `3. Правильное имя канала: @${CHANNEL_USERNAME.replace('@', '')}`,
      { parse_mode: 'HTML' })
  }
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

// обработка сообщений (рассылка или обычное сообщение)
bot.on('message', async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username
  
  // сохраняем chat_id пользователя
  if (chatId) {
    addUserChatId(chatId)
  }
  
  // обработка кнопки "Старт" из reply keyboard
  if (ctx.message.text === 'Старт') {
    await handleStart(ctx)
    return
  }
  
  // если менеджер в режиме рассылки
  if (chatId && waitingForBroadcast.has(chatId) && isManager(chatId, username)) {
    const photos = ctx.message.photo || []
    const mediaGroupId = ctx.message.media_group_id
    
    // если это альбом (несколько фото), собираем их в кэш
    if (mediaGroupId && photos.length > 0) {
      const photoFileId = photos[photos.length - 1]?.file_id // берем самое большое качество
      const messageText = ctx.message.caption || ''
      
      if (!mediaGroupCache.has(mediaGroupId)) {
        mediaGroupCache.set(mediaGroupId, [])
      }
      
      const cache = mediaGroupCache.get(mediaGroupId)!
      cache.push({ 
        fileId: photoFileId,
        text: messageText // текст может быть только в последнем сообщении альбома
      })
      
      // отменяем предыдущий таймер для этого альбома (если есть)
      if (mediaGroupTimers.has(mediaGroupId)) {
        clearTimeout(mediaGroupTimers.get(mediaGroupId)!)
      }
      
      // устанавливаем новый таймер: если в течение 2 секунд не придет новое фото - обрабатываем альбом
      const timer = setTimeout(async () => {
        const allPhotos = mediaGroupCache.get(mediaGroupId) || []
        mediaGroupTimers.delete(mediaGroupId)
        
        if (allPhotos.length > 0 && allPhotos.length <= 10) {
          const photoFileIds = allPhotos.map(p => p.fileId)
          const finalText = allPhotos[allPhotos.length - 1]?.text || ''
          
          // преобразуем и валидируем форматирование (если есть текст)
          if (finalText) {
            await ctx.reply('🔍 Проверяю форматирование текста в альбоме...')
            const converted = convertToMarkdownV2(finalText)
            
            if (!converted.success || !converted.text) {
              await ctx.reply(`❌ Ошибка обработки форматирования: ${converted.error || 'неизвестная ошибка'}\n\nРассылка отменена. Проверь форматирование и попробуй еще раз или используй /cancel.`)
              waitingForBroadcast.add(chatId)
              mediaGroupCache.delete(mediaGroupId)
              return
            }
            
            // валидируем форматирование через тестовую отправку
            const validation = await validateMarkdownV2(chatId, converted.text)
            
            if (!validation.valid) {
              await ctx.reply(`❌ Ошибка форматирования: ${validation.error || 'неверное форматирование MarkdownV2'}\n\nРассылка отменена. Исправь форматирование и попробуй еще раз или используй /cancel.`)
              waitingForBroadcast.add(chatId)
              mediaGroupCache.delete(mediaGroupId)
              return
            }
          }
          
          // валидация перед рассылкой
          await ctx.reply('🔍 Проверяю альбом перед рассылкой...')
          const testSuccess = await sendMessage(chatId, finalText, photoFileIds)
          
          if (!testSuccess) {
            await ctx.reply('❌ Ошибка при проверке альбома. Рассылка отменена.\nПроверь формат сообщения и попробуй еще раз или используй /cancel.')
            waitingForBroadcast.add(chatId)
            mediaGroupCache.delete(mediaGroupId)
            return
          }
          
          await ctx.reply(`✅ Проверка пройдена. 📤 Начинаю рассылку ${userChatIds.size} пользователям...`)
          
          // отправляем всем пользователям
          let sent = 0
          let failed = 0
          
          for (const userId of userChatIds) {
            if (String(userId) === String(chatId)) continue
            
            const success = await sendMessage(userId, finalText, photoFileIds)
            if (success) {
              sent++
            } else {
              failed++
            }
            
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          
          await ctx.reply(`✅ Рассылка завершена:\nОтправлено: ${sent}\nОшибок: ${failed}`)
          waitingForBroadcast.delete(chatId)
          mediaGroupCache.delete(mediaGroupId)
        } else if (allPhotos.length > 10) {
          await ctx.reply('❌ Максимум 10 фото в одном сообщении. Отправь меньше фото или используй /cancel.')
          waitingForBroadcast.add(chatId)
          mediaGroupCache.delete(mediaGroupId)
        }
      }, 2000) // ждем 2 секунды после последнего фото альбома
      
      mediaGroupTimers.set(mediaGroupId, timer)
      return
    }
    
    // если это не альбом, обрабатываем как обычное сообщение
    waitingForBroadcast.delete(chatId)
    
    // получаем текст и фото
    const messageText = ctx.message.text || ctx.message.caption || ''
    
    if (!messageText && photos.length === 0) {
      await ctx.reply('❌ Сообщение пустое. Попробуй еще раз или используй /cancel.')
      waitingForBroadcast.add(chatId)
      return
    }
    
    // преобразуем и валидируем форматирование
    if (messageText) {
      await ctx.reply('🔍 Проверяю форматирование текста...')
      const converted = convertToMarkdownV2(messageText)
      
      if (!converted.success || !converted.text) {
        await ctx.reply(`❌ Ошибка обработки форматирования: ${converted.error || 'неизвестная ошибка'}\n\nРассылка отменена. Проверь форматирование и попробуй еще раз или используй /cancel.`)
        waitingForBroadcast.add(chatId)
        return
      }
      
      // валидируем форматирование через тестовую отправку
      const validation = await validateMarkdownV2(chatId, converted.text)
      
      if (!validation.valid) {
        await ctx.reply(`❌ Ошибка форматирования: ${validation.error || 'неверное форматирование MarkdownV2'}\n\nРассылка отменена. Исправь форматирование и попробуй еще раз или используй /cancel.`)
        waitingForBroadcast.add(chatId)
        return
      }
    }
    
    // получаем file_id фото (берем самое большое качество)
    const photoFileIds = photos.length > 0 
      ? [photos[photos.length - 1].file_id]
      : undefined
    
    // валидация: пробуем отправить тестовое сообщение менеджеру перед рассылкой
    await ctx.reply('🔍 Проверяю сообщение перед рассылкой...')
    const testSuccess = await sendMessage(chatId, messageText, photoFileIds)
    
    if (!testSuccess) {
      await ctx.reply('❌ Ошибка при проверке сообщения. Рассылка отменена.\nПроверь формат сообщения и попробуй еще раз или используй /cancel.')
      waitingForBroadcast.add(chatId)
      return
    }
    
    await ctx.reply(`✅ Проверка пройдена. 📤 Начинаю рассылку ${userChatIds.size} пользователям...`)
    
    // отправляем всем пользователям
    let sent = 0
    let failed = 0
    
    for (const userId of userChatIds) {
      // пропускаем самого менеджера
      if (String(userId) === String(chatId)) continue
      
      const success = await sendMessage(userId, messageText, photoFileIds)
      if (success) {
        sent++
      } else {
        failed++
      }
      
      // небольшая задержка чтобы не получить rate limit
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    
    await ctx.reply(`✅ Рассылка завершена:\nОтправлено: ${sent}\nОшибок: ${failed}`)
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


