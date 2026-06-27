import express from 'express'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { createWriteStream, createReadStream, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pipeline } from 'stream/promises'

const execFileAsync = promisify(execFile)
const app = express()
app.use(express.json())

const BUCKET        = process.env.S3_BUCKET              || 'koshekjewerly'
const REGION        = process.env.S3_REGION              || 'ru-central1'
const ENDPOINT      = process.env.S3_ENDPOINT_URL        || 'https://storage.yandexcloud.net'
const PUB_PREFIX    = process.env.S3_PUBLIC_URL_PREFIX   || `https://storage.yandexcloud.net/${BUCKET}`
const ENCODER_SECRET = process.env.ENCODER_SECRET

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.post('/', async (req, res) => {
  if (ENCODER_SECRET && req.headers['x-encoder-secret'] !== ENCODER_SECRET) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const { inputKey } = req.body
  if (!inputKey || typeof inputKey !== 'string') {
    return res.status(400).json({ error: 'inputKey required' })
  }

  const id        = randomUUID()
  const tmpIn     = join(tmpdir(), `${id}-in`)
  const tmpOut    = join(tmpdir(), `${id}-out.mp4`)
  const outputKey = `products/${id}.mp4`

  try {
    console.log(`[encode] start  inputKey=${inputKey}`)

    // 1. скачиваем сырьё из S3 (incoming/)
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: inputKey }))
    await pipeline(obj.Body, createWriteStream(tmpIn))
    console.log(`[encode] downloaded to ${tmpIn}`)

    // 2. конвертируем FFmpeg
    // -movflags +faststart критично: двигает moov-атом в начало — браузер начинает играть
    // не дождавшись полной загрузки.
    await execFileAsync('ffmpeg', [
      '-i', tmpIn,
      '-an',
      '-vf', "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
      '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2',
      '-pix_fmt', 'yuv420p',
      '-crf', '21', '-preset', 'slow',
      '-movflags', '+faststart',
      '-y', tmpOut,
    ], { maxBuffer: 64 * 1024 * 1024 })
    console.log(`[encode] ffmpeg done → ${tmpOut}`)

    // 3. заливаем результат в S3 products/ (public-read)
    const { size } = statSync(tmpOut)
    await s3.send(new PutObjectCommand({
      Bucket:        BUCKET,
      Key:           outputKey,
      Body:          createReadStream(tmpOut),
      ContentLength: size,
      ContentType:   'video/mp4',
      ACL:           'public-read',
    }))

    const url = `${PUB_PREFIX.replace(/\/+$/, '')}/${outputKey}`
    console.log(`[encode] uploaded  url=${url}  size=${(size / 1024 / 1024).toFixed(1)}MB`)
    res.json({ url })
  } catch (err) {
    console.error('[encode] error', err)
    res.status(500).json({ error: err.message || 'encode_failed' })
  } finally {
    for (const f of [tmpIn, tmpOut]) {
      try { unlinkSync(f) } catch {}
    }
  }
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => console.log(`video-encoder listening on :${PORT}`))
