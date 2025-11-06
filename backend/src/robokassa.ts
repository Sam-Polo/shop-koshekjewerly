import crypto from 'node:crypto'
import pino from 'pino'

const logger = pino()

// параметры Робокассы из env
const MERCHANT_LOGIN = process.env.ROBOKASSA_MERCHANT_LOGIN || ''
const PASSWORD_1 = process.env.ROBOKASSA_PASSWORD_1 || '' // для создания платежа
const PASSWORD_2 = process.env.ROBOKASSA_PASSWORD_2 || '' // для проверки callback
const IS_TEST = process.env.ROBOKASSA_TEST === 'true' || process.env.ROBOKASSA_TEST === '1'

// базовый URL Робокассы (одинаковый для теста и production)
const ROBOKASSA_URL = 'https://auth.robokassa.ru/Merchant/Index.aspx'

// создаем MD5 подпись для создания платежа
function createPaymentSignature(
  merchantLogin: string,
  outSum: string,
  invoiceId: string,
  password: string,
  description?: string
): string {
  const str = `${merchantLogin}:${outSum}:${invoiceId}:${password}`
  return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}

// создаем MD5 подпись для проверки callback
function createResultSignature(
  outSum: string,
  invoiceId: string,
  password: string,
  additionalParams?: Record<string, string>
): string {
  let str = `${outSum}:${invoiceId}:${password}`
  
  // добавляем дополнительные параметры если есть (в алфавитном порядке ключей)
  if (additionalParams && Object.keys(additionalParams).length > 0) {
    const sortedKeys = Object.keys(additionalParams).sort()
    for (const key of sortedKeys) {
      str += `:${additionalParams[key]}`
    }
  }
  
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase()
}

// генерируем URL для оплаты
export function generatePaymentUrl(params: {
  orderId: string // внутренний ID заказа (для логирования)
  invoiceId: string // числовой ID для Робокассы (InvId)
  amount: number
  description?: string
  email?: string
  successUrl?: string
  failUrl?: string
}): string {
  if (!MERCHANT_LOGIN || !PASSWORD_1) {
    throw new Error('ROBOKASSA_MERCHANT_LOGIN и ROBOKASSA_PASSWORD_1 должны быть заданы')
  }
  
  const { orderId, invoiceId, amount, description, email, successUrl, failUrl } = params
  
  // сумма с двумя знаками после запятой
  const outSum = amount.toFixed(2)
  
  // создаем подпись (используем invoiceId для подписи)
  const signature = createPaymentSignature(
    MERCHANT_LOGIN,
    outSum,
    invoiceId,
    PASSWORD_1,
    description
  )
  
  // формируем URL
  const url = new URL(ROBOKASSA_URL)
  url.searchParams.set('MerchantLogin', MERCHANT_LOGIN)
  url.searchParams.set('OutSum', outSum)
  url.searchParams.set('InvId', invoiceId) // используем числовой ID
  url.searchParams.set('SignatureValue', signature)
  
  if (description) {
    url.searchParams.set('Description', description)
  }
  
  if (email) {
    url.searchParams.set('Email', email)
  }
  
  if (successUrl) {
    url.searchParams.set('SuccessURL', successUrl)
  }
  
  if (failUrl) {
    url.searchParams.set('FailURL', failUrl)
  }
  
  // для тестового режима
  if (IS_TEST) {
    url.searchParams.set('IsTest', '1')
  }
  
  const finalUrl = url.toString()
  
  // логируем для отладки (без паролей)
  logger.info({
    merchantLogin: MERCHANT_LOGIN,
    outSum,
    invoiceId,
    orderId, // внутренний ID для справки
    isTest: IS_TEST,
    hasDescription: !!description,
    hasSuccessUrl: !!successUrl,
    hasFailUrl: !!failUrl
  }, 'генерируем URL для оплаты в Робокассе')
  
  return finalUrl
}

// проверяем подпись от callback
export function verifyResultSignature(params: {
  outSum: string
  invoiceId: string
  signature: string
  additionalParams?: Record<string, string>
}): boolean {
  if (!PASSWORD_2) {
    logger.warn('ROBOKASSA_PASSWORD_2 не задан, проверка подписи пропущена')
    return false
  }
  
  const { outSum, invoiceId, signature, additionalParams } = params
  
  const expectedSignature = createResultSignature(outSum, invoiceId, PASSWORD_2, additionalParams)
  
  const isValid = signature.toUpperCase() === expectedSignature
  
  if (!isValid) {
    logger.warn({ 
      received: signature.toUpperCase(), 
      expected: expectedSignature 
    }, 'неверная подпись от Робокассы')
  }
  
  return isValid
}

// экспортируем константы для использования в других модулях
export { IS_TEST, MERCHANT_LOGIN }

