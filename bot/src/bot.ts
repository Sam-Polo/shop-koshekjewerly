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

// отправка сообщения через Telegram Bot API (для рассылки)
async function sendMessage(chatId: string | number, text: string, photoFileId?: string): Promise<boolean> {
  try {
    if (photoFileId) {
      // отправка с фото (используем file_id напрямую)
      const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          photo: photoFileId,
          caption: text,
          parse_mode: 'HTML'
        })
      })
      return response.ok
    } else {
      // отправка текста
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML'
        })
      })
      return response.ok
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
    
    // создаем клавиатуру с кнопкой WebApp
    const kb = new InlineKeyboard().webApp('Открыть каталог 🛍️', WEBAPP_URL)
    
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
    waitingForBroadcast.delete(chatId)
    
    // получаем текст и фото
    const messageText = ctx.message.text || ctx.message.caption || ''
    const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1] : null
    
    if (!messageText && !photo) {
      await ctx.reply('❌ Сообщение пустое. Попробуй еще раз или используй /cancel.')
      waitingForBroadcast.add(chatId)
      return
    }
    
    // получаем file_id фото если есть
    const photoFileId = photo?.file_id
    
    await ctx.reply(`📤 Начинаю рассылку ${userChatIds.size} пользователям...`)
    
    // отправляем всем пользователям
    let sent = 0
    let failed = 0
    
    for (const userId of userChatIds) {
      // пропускаем самого менеджера
      if (String(userId) === String(chatId)) continue
      
      const success = await sendMessage(userId, messageText, photoFileId)
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


