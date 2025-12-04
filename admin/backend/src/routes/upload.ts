import express from 'express'
import multer from 'multer'
import { requireAuth } from '../auth.js'
import { uploadToUploadcare } from '../uploadcare.js'
import pino from 'pino'

const logger = pino()
const router = express.Router()

// все роуты требуют авторизации
router.use(requireAuth)

// настройка multer для загрузки файлов в память
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB максимум
  },
  fileFilter: (req, file, cb) => {
    // поддерживаем jpeg, jpg, png, webp
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    if (allowedTypes.includes(file.mimetype.toLowerCase())) {
      cb(null, true)
    } else {
      cb(new Error('Разрешены только изображения: JPG, PNG, WebP'))
    }
  }
})

// загрузка фото в Uploadcare
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'файл не загружен' })
    }

    const fileUrl = await uploadToUploadcare(req.file.buffer, req.file.originalname, req.file.mimetype)
    res.json({ url: fileUrl })
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка загрузки фото')
    res.status(500).json({ error: error?.message || 'failed_to_upload' })
  }
})

export default router

