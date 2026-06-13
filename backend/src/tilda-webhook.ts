import type { Request, Response } from 'express'
import pino from 'pino'

const logger = pino()

export function handleTildaOrder(req: Request, res: Response): void {
  res.sendStatus(200)
  if (req.body?.test === 'test') return
  logger.info({ body: req.body }, 'Tilda order webhook received')
}
