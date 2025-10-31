import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';

const token = process.env.TG_BOT_TOKEN;
if (!token) {
  throw new Error('env TG_BOT_TOKEN is required');
}

const bot = new Bot(token);

const WEBAPP_URL = process.env.TG_WEBAPP_URL ?? 'http://localhost:5173';
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME ?? 'semyonp88';

bot.command('start', async (ctx) => {
  const kb = new InlineKeyboard().webApp('открыть магазин', WEBAPP_URL);
  await ctx.reply('добро пожаловать в магазин украшений', { reply_markup: kb });
});

bot.command('support', async (ctx) => {
  await ctx.reply(`написать менеджеру: https://t.me/${SUPPORT_USERNAME}`);
});

bot.on('message', async (ctx) => {
  await ctx.reply('используй /start чтобы открыть мини‑приложение');
});

bot.start();


