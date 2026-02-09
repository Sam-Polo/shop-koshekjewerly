import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import pino from 'pino'

// настройка логгера с поддержкой русских символов в Windows
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname',
      // отключаем форматирование сообщений для корректной работы с кириллицей
      singleLine: false,
      hideObject: false
    }
  }
})

const app = express()
const PORT = process.env.PORT || 4001

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

