import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { logger } from './logger.js'

let cachedClient: S3Client | null = null

function getClient(): S3Client {
  if (cachedClient) return cachedClient

  const endpoint = process.env.S3_ENDPOINT_URL
  const region = process.env.S3_REGION
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('S3_ENDPOINT_URL, S3_REGION, AWS_ACCESS_KEY_ID и AWS_SECRET_ACCESS_KEY должны быть заданы в .env')
  }

  cachedClient = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true
  })
  return cachedClient
}

function extFromMime(mime: string, fallback: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  }
  return map[mime.toLowerCase()] || fallback.replace(/^\./, '') || 'bin'
}

// загрузка файла в S3-совместимое хранилище (Timeweb), возврат публичного URL
export async function uploadToS3(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<string> {
  const bucket = process.env.S3_BUCKET
  const publicPrefix = process.env.S3_PUBLIC_URL_PREFIX
  const keyPrefix = (process.env.S3_KEY_PREFIX || '').replace(/^\/+|\/+$/g, '')

  if (!bucket || !publicPrefix) {
    throw new Error('S3_BUCKET и S3_PUBLIC_URL_PREFIX должны быть заданы в .env')
  }

  const ext = extFromMime(mimeType, path.extname(fileName))
  const objectName = `${randomUUID()}.${ext}`
  const key = keyPrefix ? `${keyPrefix}/${objectName}` : objectName

  const client = getClient()

  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
      ACL: 'public-read'
    }))
  } catch (error: any) {
    logger.error({
      error: error?.message,
      code: error?.Code || error?.name,
      fileName,
      key
    }, 'ошибка при загрузке в S3')
    throw new Error(`Ошибка загрузки в S3: ${error?.message || 'unknown'}`)
  }

  const fileUrl = `${publicPrefix.replace(/\/+$/, '')}/${key}`
  logger.info({ fileName, fileUrl, sizeBytes: fileBuffer.length }, 'файл загружен в S3')
  return fileUrl
}

// заливка сырого файла в S3 СТРИМОМ (без буфера в памяти) под префикс incoming/.
// используется для видео перед конвертацией: контейнер скачивает его по key, сжимает
// и кладёт результат в products/. см. docs/VIDEO_SUPPORT.md
export async function uploadRawToS3FromPath(
  filePath: string,
  originalName: string,
  mimeType: string,
  sizeBytes: number
): Promise<{ key: string; bucket: string }> {
  const bucket = process.env.S3_BUCKET
  if (!bucket) {
    throw new Error('S3_BUCKET должен быть задан в .env')
  }
  const incomingPrefix = (process.env.S3_INCOMING_PREFIX || 'incoming').replace(/^\/+|\/+$/g, '')

  const ext = path.extname(originalName).replace(/^\./, '') || 'bin'
  const objectName = `${randomUUID()}.${ext}`
  const key = incomingPrefix ? `${incomingPrefix}/${objectName}` : objectName

  const client = getClient()

  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentLength: sizeBytes,
      ContentType: mimeType
      // без ACL: сырьё не публичное, контейнер читает по ключу с креденшелами
    }))
  } catch (error: any) {
    logger.error({
      error: error?.message,
      code: error?.Code || error?.name,
      originalName,
      key
    }, 'ошибка при заливке сырого видео в S3')
    throw new Error(`Ошибка загрузки в S3: ${error?.message || 'unknown'}`)
  }

  logger.info({ originalName, key, sizeBytes }, 'сырое видео залито в S3 (incoming)')
  return { key, bucket }
}
