import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { InputFile } from 'grammy';
import path from 'path';
import { fileURLToPath } from 'url';

const token = process.env.TG_BOT_TOKEN;
if (!token) {
  throw new Error('env TG_BOT_TOKEN is required');
}

const bot = new Bot(token);

const WEBAPP_URL = process.env.TG_WEBAPP_URL ?? 'http://localhost:5173';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME;
const MANAGER_CHAT_ID = process.env.TG_MANAGER_CHAT_ID;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// хранилище chat_id всех пользователей для рассылки
const userChatIds = new Set<string | number>();

// проверка что пользователь - менеджер
function isManager(chatId: string | number | undefined, username?: string): boolean {
  if (!chatId) {
    console.log('[isManager] chatId отсутствует')
    return false
  }
  
  console.log('[isManager] проверка:', { chatId, username, MANAGER_CHAT_ID, SUPPORT_USERNAME })
  
  // проверка по chat_id
  if (MANAGER_CHAT_ID) {
    const isMatch = String(chatId) === String(MANAGER_CHAT_ID)
    console.log('[isManager] проверка по chat_id:', isMatch, { chatId, MANAGER_CHAT_ID })
    if (isMatch) {
      return true
    }
  } else {
    console.log('[isManager] TG_MANAGER_CHAT_ID не задан')
  }
  
  // проверка по username
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

bot.command('start', async (ctx) => {
  // сохраняем chat_id пользователя для рассылки
  const chatId = ctx.from?.id
  if (chatId) {
    userChatIds.add(chatId)
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
    caption: 'Добро пожаловать в мир KOSHEK.\nЗдесь вы можете оформить свой заказ. 💖',
    reply_markup: kb,
  });
});

bot.command('support', async (ctx) => {
  await ctx.reply(`написать менеджеру: https://t.me/${SUPPORT_USERNAME}`);
});

// обработка сообщений (рассылка или обычное сообщение)
bot.on('message', async (ctx) => {
  const chatId = ctx.from?.id
  const username = ctx.from?.username
  
  // сохраняем chat_id пользователя
  if (chatId) {
    userChatIds.add(chatId)
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

bot.start();


