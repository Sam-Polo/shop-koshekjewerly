import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { fetchProductsFromSheet } from './sheets';
import { listProducts, upsertProducts } from './store';

const logger = pino();
const app = express();

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

// import from google sheets
app.post('/admin/import/sheets', async (req, res) => {
  const key = req.header('x-admin-key');
  if (!key || key !== process.env.ADMIN_IMPORT_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const sheetId = process.env.IMPORT_SHEET_ID;
  if (!sheetId) return res.status(400).json({ error: 'missing IMPORT_SHEET_ID' });
  try {
    const rows = await fetchProductsFromSheet(sheetId);
    upsertProducts(rows);
    res.json({ ok: true, imported: rows.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'import_failed' });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  logger.info({ port }, 'backend started');
});


