import express from 'express'
import multer from 'multer'
import { requireAuth } from '../auth.js'
import { uploadToUploadcare } from '../uploadcare.js'
import { logger } from '../logger.js'

const router = express.Router()

// все роуты требуют авторизации
router.use(requireAuth)

// 50MB — достаточно для 4K и тяжёлых фото
const MAX_FILE_SIZE = 30 * 1024 * 1024

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    if (allowedTypes.includes(file.mimetype.toLowerCase())) {
      cb(null, true)
    } else {
      cb(new Error('Разрешены только изображения: JPG, PNG, WebP'))
    }
  }
})

// загрузка фото в Uploadcare + обработка ошибок multer (лимит размера и т.д.)
router.post(
  '/',
  upload.single('file'),
  async (req: express.Request, res: express.Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'файл не загружен' })
      }

      const fileUrl = await uploadToUploadcare(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      )
      res.json({ url: fileUrl })
    } catch (error: any) {
      logger.error({ error: error?.message, stack: error?.stack }, 'ошибка загрузки фото')
      res.status(500).json({ error: error?.message || 'failed_to_upload' })
    }
  },
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        logger.warn({ limit: MAX_FILE_SIZE }, 'загрузка фото: превышен размер файла')
        return res.status(400).json({ error: 'file_too_large' })
      }
      logger.error({ code: err.code, message: err.message }, 'ошибка multer при загрузке')
      return res.status(400).json({ error: err.message || 'upload_failed' })
    }
    if (err) {
      logger.error({ error: err?.message }, 'ошибка при загрузке фото')
      return res.status(400).json({ error: err.message || 'upload_failed' })
    }
  }
)

export default router

