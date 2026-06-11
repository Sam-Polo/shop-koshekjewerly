import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

let client: S3Client | null = null

function getClient(): S3Client {
  if (!client) {
    const endpoint = process.env.S3_ENDPOINT_URL
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
    if (!endpoint) throw new Error('S3_ENDPOINT_URL not set')
    if (!accessKeyId || !secretAccessKey) throw new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set')
    client = new S3Client({
      endpoint,
      region: 'ru-central1',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    })
  }
  return client
}

export async function uploadBufferToS3(key: string, buffer: Buffer, contentType: string): Promise<string> {
  const bucket = process.env.S3_BUCKET
  if (!bucket) throw new Error('S3_BUCKET not set')
  const prefix = process.env.S3_PUBLIC_URL_PREFIX
  if (!prefix) throw new Error('S3_PUBLIC_URL_PREFIX not set')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    await getClient().send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }),
      { abortSignal: ctrl.signal }
    )
    clearTimeout(timer)
  } catch (e) {
    clearTimeout(timer)
    throw e
  }

  return `${prefix.replace(/\/$/, '')}/${key}`
}
