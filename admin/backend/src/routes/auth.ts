import express from 'express'
import { generateToken } from '../auth.js'
import pino from 'pino'

const logger = pino()
const router = express.Router()

// простой логин (в будущем можно добавить проверку пароля)
// пока что один пользователь с фиксированными данными
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body
    
    // TODO: добавить проверку пароля из env или базы данных
    // пока что простой хардкод для тестирования
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin'
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
    
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      logger.warn({ username }, 'неудачная попытка входа')
      return res.status(401).json({ error: 'invalid_credentials' })
    }
    
    const token = generateToken({
      userId: '1',
      username: ADMIN_USERNAME
    })
    
    logger.info({ username }, 'успешный вход в админ-панель')
    
    res.json({ token })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка при входе')
    res.status(500).json({ error: 'login_failed' })
  }
})

export default router

