import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { logger } from './logger.js'

const app = express()
const PORT = process.env.PORT || 4001

// лог каждого входящего запроса (до разбора body) — чтобы видеть, доходят ли большие запросы до Node
app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  const len = req.headers['content-length']
  logger.info({ method: req.method, url: req.url, contentLength: len ?? '—' }, 'входящий запрос')
  next()
})

// CORS настройка
const frontendUrl = process.env.ADMIN_FRONTEND_URL || 'http://localhost:5174'
app.use(cors({
  origin: frontendUrl,
  credentials: true
}))

// ограничение размера JSON body для защиты от DoS
app.use(express.json({ limit: '1mb' }))

// health check
app.get('/health', (req: express.Request, res: express.Response) => {
  res.json({ status: 'ok' })
})

// роуты
import authRoutes from './routes/auth.js'
import productRoutes from './routes/products.js'
import uploadRoutes from './routes/upload.js'
import promocodeRoutes from './routes/promocodes.js'
import settingsRoutes from './routes/settings.js'
import categoriesRoutes from './routes/categories.js'

app.use('/api/auth', authRoutes)
app.use('/api/products', productRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/promocodes', promocodeRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/categories', categoriesRoutes)

app.listen(PORT, () => {
  logger.info(`Админ-панель бэкенд запущен на порту ${PORT}`)
})

