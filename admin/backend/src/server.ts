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
import basesRoutes from './routes/bases.js'
import pendantsRoutes from './routes/pendants.js'
import articlesRoutes from './routes/articles.js'
import ordersRoutes from './routes/orders.js'
import customersRoutes from './routes/customers.js'
import statsRoutes from './routes/stats.js'

app.use('/api/auth', authRoutes)
app.use('/api/products', productRoutes)
app.use('/api/upload', uploadRoutes)
app.use('/api/promocodes', promocodeRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/categories', categoriesRoutes)
app.use('/api/bases', basesRoutes)
app.use('/api/pendants', pendantsRoutes)
app.use('/api/articles', articlesRoutes)
app.use('/api/orders', ordersRoutes)
app.use('/api/customers', customersRoutes)
app.use('/api/stats', statsRoutes)

app.listen(PORT, () => {
  logger.info(`Админ-панель бэкенд запущен на порту ${PORT}`)
})

