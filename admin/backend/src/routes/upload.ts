import express from 'express'
import multer from 'multer'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { requireAuth } from '../auth.js'
import { uploadToS3, uploadRawToS3FromPath } from '../s3.js'
import { isVideoEncoderConfigured, convertVideo } from '../videoEncoder.js'
import { logger } from '../logger.js'

const router = express.Router()

// все роуты требуют авторизации
router.use(requireAuth)

const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_VIDEO_SIZE = 200 * 1024 * 1024

const ALLOWED_IMAGE = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
const ALLOWED_VIDEO = ['video/mp4', 'video/webm', 'video/quicktime']

function isImageMime(m: string): boolean {
  return ALLOWED_IMAGE.includes(m.toLowerCase())
}
function isVideoMime(m: string): boolean {
  const lower = m.toLowerCase()
  return ALLOWED_VIDEO.includes(lower) || lower.startsWith('video/')
}

// diskStorage, а не memoryStorage: видео ~100МБ нельзя буферить в heap на VDS с 1GB RAM.
// см. docs/VIDEO_SUPPORT.md (риск 1)
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || ''}`)
  }),
  limits: { fileSize: MAX_VIDEO_SIZE },
  fileFilter: (_req, file, cb) => {
    if (isImageMime(file.mimetype) || isVideoMime(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('Разрешены фото (JPG, PNG, WebP) и видео (MP4, WebM, MOV)'))
    }
  }
})

// загрузка фото/видео в S3 + обработка ошибок multer
router.post(
  '/',
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.info('POST /api/upload — запрос получен, ожидаем тело с файлом')
    next()
  },
  upload.single('file'),
  async (req: express.Request, res: express.Response) => {
    const file = req.file
    if (!file) {
      logger.warn('запрос без файла или поле не "file"')
      return res.status(400).json({ error: 'файл не загружен' })
    }

    const tmpPath = file.path
    const video = isVideoMime(file.mimetype)

    try {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
      logger.info({ name: file.originalname, sizeBytes: file.size, sizeMB, mimetype: file.mimetype, video }, 'файл принят')

      if (video) {
        if (file.size > MAX_VIDEO_SIZE) {
          return res.status(400).json({ error: 'file_too_large' })
        }
        if (!isVideoEncoderConfigured()) {
          logger.warn('видео загружено, но VIDEO_ENCODER_URL не настроен')
          return res.status(503).json({ error: 'video_encoder_not_configured' })
        }
        // 1. сырое видео → S3 (incoming/), стримом, без буфера в памяти
        const { key } = await uploadRawToS3FromPath(tmpPath, file.originalname, file.mimetype, file.size)
        // 2. контейнер скачивает, сжимает, кладёт в products/ и возвращает URL
        const url = await convertVideo(key)
        return res.json({ url })
      }

      // фото: проверяем размер и заливаем как раньше
      if (file.size > MAX_IMAGE_SIZE) {
        return res.status(400).json({ error: 'file_too_large' })
      }
      const buffer = await fsp.readFile(tmpPath)
      const fileUrl = await uploadToS3(buffer, file.originalname, file.mimetype)
      return res.json({ url: fileUrl })
    } catch (error: any) {
      const errMsg = error?.message
      logger.error({
        error: errMsg,
        code: error?.code,
        status: error?.response?.status,
        data: error?.response?.data,
        stack: error?.stack,
        video
      }, 'ошибка загрузки файла')
      if (errMsg === 'video_encoder_not_configured') {
        return res.status(503).json({ error: errMsg })
      }
      return res.status(500).json({ error: errMsg || 'failed_to_upload' })
    } finally {
      // чистим временный файл в любом случае
      fsp.unlink(tmpPath).catch(() => {})
    }
  },
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        logger.warn({ limit: MAX_VIDEO_SIZE }, 'загрузка: превышен размер файла')
        return res.status(400).json({ error: 'file_too_large' })
      }
      logger.error({ code: err.code, message: err.message }, 'ошибка multer при загрузке')
      return res.status(400).json({ error: err.message || 'upload_failed' })
    }
    if (err) {
      logger.error({ error: err?.message, name: err?.name }, 'ошибка при загрузке (fileFilter или multer)')
      return res.status(400).json({ error: err?.message || 'upload_failed' })
    }
  }
)

export default router
