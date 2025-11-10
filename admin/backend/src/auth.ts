import jwt from 'jsonwebtoken'
import express from 'express'
import pino from 'pino'

const logger = pino()

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET не задан в переменных окружения')
}

// время жизни токена: 30 минут
const TOKEN_EXPIRES_IN = '30m'

export interface TokenPayload {
  userId: string
  username: string
}

// генерация JWT токена
export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET as string, { expiresIn: TOKEN_EXPIRES_IN })
}

// проверка JWT токена
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET as string)
    if (typeof decoded === 'object' && decoded !== null && 'userId' in decoded && 'username' in decoded) {
      return decoded as TokenPayload
    }
    return null
  } catch (error: any) {
    logger.warn({ error: error?.message }, 'ошибка проверки JWT токена')
    return null
  }
}

// middleware для проверки авторизации
export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const token = authHeader.substring(7)
  const payload = verifyToken(token)
  
  if (!payload) {
    return res.status(401).json({ error: 'invalid_token' })
  }

  // добавляем данные пользователя в запрос
  ;(req as any).user = payload
  next()
}

