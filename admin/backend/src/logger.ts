import pino from 'pino'

// время в формате МСК для логов
function mskTime(): string {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

const pinoOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  timestamp: () => `,"time":"${mskTime()}"`,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: false, // уже в МСК в поле time
            ignore: 'pid,hostname',
            singleLine: false,
            hideObject: false
          }
        }
}

export const logger = pino(pinoOptions)
