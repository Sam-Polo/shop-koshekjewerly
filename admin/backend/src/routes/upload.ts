import express from 'express'
import multer from 'multer'
import { requireAuth } from '../auth.js'
import { uploadToUploadcare } from '../uploadcare.js'
import { logger } from '../logger.js'

const router = express.Router()

// все роуты требуют авторизации
router.use(requireAuth)

// лимит API Uploadcare — 10 MB
const MAX_FILE_SIZE = 10 * 1024 * 1024

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

// загрузка фото в Uploadcare + обработка ошибок multer
router.post(
  '/',
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.info('POST /api/upload — запрос получен, ожидаем тело с файлом')
    next()
  },
  upload.single('file'),
  async (req: express.Request, res: express.Response) => {
    try {
      if (!req.file) {
        logger.warn('запрос без файла или поле не "file"')
        return res.status(400).json({ error: 'файл не загружен' })
      }

      const sizeMB = (req.file.size / (1024 * 1024)).toFixed(2)
      logger.info({ name: req.file.originalname, sizeBytes: req.file.size, sizeMB }, 'файл принят, отправка в Uploadcare')

      const fileUrl = await uploadToUploadcare(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      )
      res.json({ url: fileUrl })
    } catch (error: any) {
      const errMsg = error?.message
      const errResponse = error?.response
      logger.error({
        error: errMsg,
        code: error?.code,
        status: errResponse?.status,
        data: errResponse?.data,
        stack: error?.stack
      }, 'ошибка загрузки фото')
      res.status(500).json({ error: errMsg || 'failed_to_upload' })
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
      logger.error({ error: err?.message, name: err?.name }, 'ошибка при загрузке фото (fileFilter или multer)')
      return res.status(400).json({ error: err?.message || 'upload_failed' })
    }
  }
)

export default router

