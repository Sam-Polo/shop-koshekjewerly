import axios from 'axios'
import { logger } from './logger.js'

// Конвертация видео делегирована бессерверному контейнеру с FFmpeg (Yandex Serverless
// Containers). Здесь — только HTTP-клиент к нему. Контейнер настраивается вручную вне
// репозитория (как PM2/nginx). Полное описание и контракт — в docs/VIDEO_SUPPORT.md.
//
// Контракт:
//   POST <VIDEO_ENCODER_URL>
//   headers: { 'Content-Type': 'application/json', 'X-Encoder-Secret': <VIDEO_ENCODER_SECRET> }
//   body:    { "inputKey": "incoming/<uuid>.<ext>" }
//   200 OK:  { "url": "https://storage.yandexcloud.net/koshekjewerly/products/<uuid>.mp4" }
// Контейнер сам скачивает inputKey из S3, сжимает (1080p, H.264, без звука, +faststart),
// заливает результат в products/ с public-read и возвращает его публичный URL.

export function isVideoEncoderConfigured(): boolean {
  return !!process.env.VIDEO_ENCODER_URL
}

export async function convertVideo(inputKey: string): Promise<string> {
  const url = process.env.VIDEO_ENCODER_URL
  const secret = process.env.VIDEO_ENCODER_SECRET
  if (!url) {
    throw new Error('video_encoder_not_configured')
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret) headers['X-Encoder-Secret'] = secret

  // таймаут чуть меньше клиентского (300с в admin/frontend api.uploadImage)
  const resp = await axios.post(
    url,
    { inputKey },
    { headers, timeout: 280_000, validateStatus: () => true }
  )

  if (resp.status < 200 || resp.status >= 300) {
    logger.error({ status: resp.status, data: resp.data, inputKey }, 'video encoder вернул ошибку')
    throw new Error(`encoder_http_${resp.status}`)
  }

  const resultUrl = resp.data?.url
  if (!resultUrl || typeof resultUrl !== 'string') {
    logger.error({ data: resp.data, inputKey }, 'video encoder не вернул url')
    throw new Error('encoder_no_url')
  }

  logger.info({ inputKey, resultUrl }, 'видео сконвертировано контейнером')
  return resultUrl
}
