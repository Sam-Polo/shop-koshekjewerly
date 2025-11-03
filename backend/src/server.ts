import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { fetchProductsFromSheet } from './sheets.js';
import { listProducts, upsertProducts } from './store.js';

const logger = pino();
const app = express();

// автоматический импорт товаров из google sheets
async function importProducts() {
  const sheetId = process.env.IMPORT_SHEET_ID;
  if (!sheetId) {
    logger.warn('IMPORT_SHEET_ID не задан, импорт пропущен');
    return;
  }
  try {
    logger.info('импорт товаров из google sheets...');
    const rows = await fetchProductsFromSheet(sheetId);
    upsertProducts(rows);
    logger.info({ imported: rows.length }, 'товары импортированы');
  } catch (e: any) {
    logger.error({ error: e?.message }, 'ошибка импорта товаров');
  }
}

app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: process.env.TG_WEBAPP_URL ?? true }));

// health
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// products
app.get('/api/products', (_req, res) => {
  const items = listProducts().filter(p => p.active)
  res.json({ items, total: items.length });
});

// ручной импорт (для тестов или форс-обновления)
app.post('/admin/import/sheets', async (req, res) => {
  const key = req.header('x-admin-key');
  if (!key || key !== process.env.ADMIN_IMPORT_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    await importProducts();
    const count = listProducts().length;
    res.json({ ok: true, total: count });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'import_failed' });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, async () => {
  logger.info({ port }, 'backend started');
  
  // импорт при запуске
  await importProducts();
  
  // периодический импорт (по умолчанию каждые 10 минут)
  const intervalMinutes = Number(process.env.IMPORT_INTERVAL_MINUTES ?? 10);
  if (intervalMinutes > 0) {
    setInterval(() => {
      importProducts();
    }, intervalMinutes * 60 * 1000);
    logger.info({ intervalMinutes }, 'периодический импорт настроен');
  }
});


