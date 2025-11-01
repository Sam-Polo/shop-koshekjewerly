# инструкция по деплою

## что деплоим

- **backend** → Render (Web Service)
- **frontend** → GitHub Pages (с автобилдом через Actions)
- **bot** → локально (или Render Web Service позже)

---

## шаг 1: GitHub репозиторий

```bash
git init
git add .
git commit -m "feat: scaffold + gsheets import + catalog ui"
git branch -M main
git remote add origin https://github.com/<username>/shop-koshekjewerly.git
git push -u origin main
```

---

## шаг 2: backend на Render

1) https://render.com → New → **Web Service** → выбери репозиторий

2) настройки:
   - **Name**: `shop-backend`
   - **Root Directory**: `backend`
   - **Build Command**: `cd backend && npm install --include=dev && npm run build`
   - **Start Command**: `cd backend && npm start`

3) переменные окружения:
   ```
   PORT=4000
   NODE_ENV=production
   IMPORT_SHEET_ID=1aqnsr0oseSfm5ZErHaz9sl_eUMdJQGpnERrdf3ztZvI
   GOOGLE_SA_JSON={"type":"service_account",...}
   ADMIN_IMPORT_KEY=dev-key
   TG_WEBAPP_URL=будет_после_деплоя_фронта
   ```

4) после деплоя импорт каталога (PowerShell):
   ```powershell
   Invoke-RestMethod -Method Post "https://shop-koshekjewerly.onrender.com/admin/import/sheets" -Headers @{ "x-admin-key"="dev-key" }
   ```

---

## шаг 3: frontend на GitHub Pages

1) **Settings** → **Secrets and variables** → **Actions**:
   - добавь `VITE_API_URL` = URL твоего бэка: `https://shop-koshekjewerly.onrender.com`

2) **Settings** → **Pages**:
   - **Source**: **GitHub Actions**

3) закоммить workflow (если ещё не закоммичен):
   ```bash
   git add .github/workflows/deploy-frontend.yml frontend/vite.config.ts frontend/package.json frontend/public/
   git commit -m "feat: GitHub Actions для автобилда фронта"
   git push
   ```

4) подожди деплоя (Actions запустится автоматически), URL будет `https://<username>.github.io/shop-koshekjewerly/`

---

## шаг 4: bot локально

1) создай `bot/.env`:
   ```
   TG_BOT_TOKEN=твой_токен
   TG_WEBAPP_URL=https://<username>.github.io/shop-koshekjewerly/
   SUPPORT_USERNAME=semyonp88
   ```

2) запусти:
   ```bash
   cd bot
   npm install
   npm run dev
   ```

---

## шаг 5: обновить переменные

**backend (Render)**: обнови `TG_WEBAPP_URL` = URL фронта с GitHub Pages

**bot**: обнови `bot/.env` → `TG_WEBAPP_URL` = URL фронта → перезапусти бота

---

## проверка

1) фронт в браузере → должен загрузиться
2) Telegram: `/start` → «открыть магазин» → мини‑апп открывается
3) товары загружаются

---

## обновление кода

```bash
git add .
git commit -m "описание"
git push
```

Render и GitHub Actions автоматически пересоберут и задеплоят.

---

## примечания

- Render бесплатный план "засыпает" после 15 мин → первый запрос медленный
- для production смени `ADMIN_IMPORT_KEY` на надёжный
