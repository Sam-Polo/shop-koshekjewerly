/**
 * Миграция файлов из Timeweb S3 → Yandex Cloud Object Storage
 *
 * Запуск:
 *   cd admin/backend
 *   node scripts/migrate-s3.mjs
 *
 * Перед запуском заполни admin/backend/.env.migrate (см. .env.migrate.example)
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { createReadStream, readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- загрузка .env.migrate ---
const envFile = resolve(__dirname, '../.env.migrate')
if (!existsSync(envFile)) {
  console.error('Файл .env.migrate не найден. Скопируй .env.migrate.example и заполни.')
  process.exit(1)
}
for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq < 0) continue
  const key = trimmed.slice(0, eq).trim()
  // убираем инлайн-комментарий и лишние пробелы/кавычки
  let val = trimmed.slice(eq + 1).replace(/#.*$/, '').trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  process.env[key] = val
}

const {
  SRC_ACCESS_KEY_ID, SRC_SECRET_ACCESS_KEY,
  DST_ACCESS_KEY_ID, DST_SECRET_ACCESS_KEY,
} = process.env

if (!SRC_ACCESS_KEY_ID || !SRC_SECRET_ACCESS_KEY || !DST_ACCESS_KEY_ID || !DST_SECRET_ACCESS_KEY) {
  console.error('Не заданы ключи доступа в .env.migrate')
  process.exit(1)
}

// --- источник: Timeweb ---
const srcClient = new S3Client({
  endpoint: 'https://s3.twcstorage.ru',
  region: 'ru-1',
  credentials: { accessKeyId: SRC_ACCESS_KEY_ID, secretAccessKey: SRC_SECRET_ACCESS_KEY },
  forcePathStyle: true,
})

// --- назначение: Yandex Cloud ---
const dstClient = new S3Client({
  endpoint: 'https://storage.yandexcloud.net',
  region: 'ru-central1',
  credentials: { accessKeyId: DST_ACCESS_KEY_ID, secretAccessKey: DST_SECRET_ACCESS_KEY },
  forcePathStyle: true,
})

const SRC_BUCKET = 'koshekjewerly-s3-bucket'
const DST_BUCKET = 'koshekjewerly'

async function streamToBuffer(stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function existsInDst(key) {
  try {
    await dstClient.send(new HeadObjectCommand({ Bucket: DST_BUCKET, Key: key }))
    return true
  } catch {
    return false
  }
}

async function migrate() {
  let token = undefined
  let total = 0, copied = 0, skipped = 0, errors = 0

  console.log(`\nМиграция: ${SRC_BUCKET} (Timeweb) → ${DST_BUCKET} (Yandex Cloud)\n`)

  do {
    const listRes = await srcClient.send(new ListObjectsV2Command({
      Bucket: SRC_BUCKET,
      ContinuationToken: token,
    }))

    for (const obj of listRes.Contents ?? []) {
      total++
      const key = obj.Key

      if (await existsInDst(key)) {
        console.log(`  SKIP  ${key}`)
        skipped++
        continue
      }

      try {
        const getRes = await srcClient.send(new GetObjectCommand({ Bucket: SRC_BUCKET, Key: key }))
        const body = await streamToBuffer(getRes.Body)

        await dstClient.send(new PutObjectCommand({
          Bucket: DST_BUCKET,
          Key: key,
          Body: body,
          ContentType: getRes.ContentType || 'application/octet-stream',
          ACL: 'public-read',
        }))

        const kb = (body.length / 1024).toFixed(1)
        console.log(`  OK    ${key}  (${kb} KB)`)
        copied++
      } catch (err) {
        console.error(`  ERROR ${key}  — ${err.message}`)
        errors++
      }
    }

    token = listRes.NextContinuationToken
  } while (token)

  console.log('\n=== Результат ===')
  console.log(`Всего объектов в источнике: ${total}`)
  console.log(`Скопировано:                ${copied}`)
  console.log(`Пропущено (уже были):       ${skipped}`)
  console.log(`Ошибок:                     ${errors}`)

  if (errors > 0) {
    console.error('\nЕсть ошибки — запусти скрипт ещё раз, он пропустит уже скопированные.')
    process.exit(1)
  }
  console.log('\nГотово ✓')
}

migrate().catch(err => {
  console.error('Критическая ошибка:', err.message)
  process.exit(1)
})
