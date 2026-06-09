import crypto from 'node:crypto'
import pino from 'pino'

const logger = pino()

// параметры Робокассы из env
const MERCHANT_LOGIN = process.env.ROBOKASSA_MERCHANT_LOGIN || ''
const PASSWORD_1 = process.env.ROBOKASSA_PASSWORD_1 || '' // для создания платежа
const PASSWORD_2 = process.env.ROBOKASSA_PASSWORD_2 || '' // для проверки callback
const IS_TEST = process.env.ROBOKASSA_TEST === 'true' || process.env.ROBOKASSA_TEST === '1'

// фискализация (54-ФЗ): параметры чека. Дефолты под УСН «доходы», без НДС.
// меняются через env без правок кода.
const RECEIPT_TAX = process.env.ROBOKASSA_TAX || 'none'                       // ставка НДС позиции
const RECEIPT_SNO = process.env.ROBOKASSA_SNO || 'usn_income'                 // система налогообложения ('' = брать из кабинета)
const RECEIPT_PAYMENT_METHOD = process.env.ROBOKASSA_PAYMENT_METHOD || 'full_payment' // признак способа расчёта

// схема кодирования Receipt для подписи/поля формы (см. buildPaymentForm).
// false (по умолчанию): значение = encodeURIComponent(JSON) — официальная страница фискализации + SDK.
// true: значение = сырой JSON — вариант из ответа техподдержки РК (если дефолт не пройдёт в тестовом режиме).
// в ОБОИХ случаях подпись считается ровно по тому значению, что уходит в поле формы.
const RECEIPT_RAW_SIGN = process.env.ROBOKASSA_RECEIPT_RAW_SIGNATURE === 'true'

// базовый URL Робокассы (одинаковый для теста и production)
const ROBOKASSA_URL = 'https://auth.robokassa.ru/Merchant/Index.aspx'

// позиция и чек номенклатуры (Receipt) для фискализации по 54-ФЗ
export type ReceiptItem = {
  name: string
  quantity: number
  sum: number
  payment_method: string
  payment_object: string
  tax: string
}
export type Receipt = {
  sno?: string
  items: ReceiptItem[]
}

// наименование позиции в чеке Робокассы ограничено 128 символами
function truncateName(name: string): string {
  const n = (name || '').trim()
  if (!n) return 'Товар'
  return n.length > 128 ? n.slice(0, 128) : n
}

// создаем MD5 подпись для создания платежа
// формат: MerchantLogin:OutSum:InvId[:Receipt]:Password1[:Shp_key=val ...] (Shp в алфавитном порядке)
// receiptValue — значение Receipt ровно в том виде, в каком оно уходит в поле формы (см. buildPaymentForm).
// порядок полей подтверждён официальным SDK robokassa/sdk-php (SignatureService::createPaymentSignature).
function createPaymentSignature(
  merchantLogin: string,
  outSum: string,
  invoiceId: string,
  password: string,
  receiptValue?: string,
  shpParams?: Record<string, string>
): string {
  let str = `${merchantLogin}:${outSum}:${invoiceId}`
  if (receiptValue) str += `:${receiptValue}`
  str += `:${password}`
  if (shpParams && Object.keys(shpParams).length > 0) {
    const sortedKeys = Object.keys(shpParams).sort()
    for (const key of sortedKeys) {
      str += `:${key}=${shpParams[key]}`
    }
  }
  return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}

// создаем MD5 подпись для проверки callback
// формат: OutSum:InvId:Password2[:Shp_key1=val1:Shp_key2=val2] (ключи в алфавитном порядке)
function createResultSignature(
  outSum: string,
  invoiceId: string,
  password: string,
  additionalParams?: Record<string, string>
): string {
  let str = `${outSum}:${invoiceId}:${password}`
  if (additionalParams && Object.keys(additionalParams).length > 0) {
    const sortedKeys = Object.keys(additionalParams).sort()
    for (const key of sortedKeys) {
      str += `:${key}=${additionalParams[key]}` // key=value, как в createPaymentSignature
    }
  }
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase()
}

// собираем чек номенклатуры (Receipt) для фискализации.
// сумма всех позиций ОБЯЗАНА точно равняться OutSum (total) — иначе чек невалиден и оплата отклоняется.
// скидку промокода распределяем по позициям пропорционально (целыми копейками, метод наибольшего остатка),
// чтобы свести сумму к total до копейки без отрицательных/нулевых строк.
// возвращает null, если корректный чек собрать не удалось — вызывающий код шлёт оплату без Receipt.
export function buildReceipt(input: {
  items: Array<{ title: string; price: number; quantity: number }>
  deliveryCost?: number
  priorityFee?: number
  discount?: number
  total: number
}): Receipt | null {
  const { items, deliveryCost = 0, priorityFee = 0, discount = 0, total } = input

  type Line = { name: string; quantity: number; sumK: number; payment_object: string }
  const lines: Line[] = []

  for (const it of items) {
    const sumK = Math.round(it.price * it.quantity * 100)
    if (sumK <= 0) continue
    lines.push({ name: truncateName(it.title), quantity: it.quantity, sumK, payment_object: 'commodity' })
  }
  if (deliveryCost > 0) {
    lines.push({ name: 'Доставка', quantity: 1, sumK: Math.round(deliveryCost * 100), payment_object: 'service' })
  }
  if (priorityFee > 0) {
    lines.push({ name: 'Приоритетная обработка заказа', quantity: 1, sumK: Math.round(priorityFee * 100), payment_object: 'service' })
  }

  if (lines.length === 0) return null

  const targetK = Math.round(total * 100)
  if (targetK <= 0) return null

  const currentK = lines.reduce((s, l) => s + l.sumK, 0)
  // в норме reduceK = скидка (>=0); допускаем мелкий дрейф округления (в т.ч. отрицательный)
  const reduceK = currentK - targetK
  if (reduceK !== 0 && currentK > 0) {
    const sign = reduceK >= 0 ? 1 : -1
    const absReduce = Math.abs(reduceK)
    const raw = lines.map(l => (absReduce * l.sumK) / currentK)
    const delta = raw.map(Math.floor)
    const assigned = delta.reduce((a, b) => a + b, 0)
    const remainder = absReduce - assigned
    const byFrac = raw
      .map((r, i) => ({ i, frac: r - Math.floor(r) }))
      .sort((a, b) => b.frac - a.frac)
    for (let k = 0; k < remainder; k++) delta[byFrac[k % byFrac.length].i] += 1
    for (let i = 0; i < lines.length; i++) lines[i].sumK -= sign * delta[i]
  }

  // финальная проверка: сумма точно равна OutSum и каждая позиция строго > 0
  const finalK = lines.reduce((s, l) => s + l.sumK, 0)
  if (finalK !== targetK || lines.some(l => l.sumK < 1)) {
    logger.warn(
      { finalK, targetK, sums: lines.map(l => l.sumK) },
      'buildReceipt: не удалось свести сумму чека к OutSum — чек не будет передан'
    )
    return null
  }

  const receipt: Receipt = {
    items: lines.map(l => ({
      name: l.name,
      quantity: l.quantity,
      sum: l.sumK / 100,
      payment_method: RECEIPT_PAYMENT_METHOD,
      payment_object: l.payment_object,
      tax: RECEIPT_TAX,
    })),
  }
  if (RECEIPT_SNO) receipt.sno = RECEIPT_SNO
  return receipt
}

// формируем поля для POST-формы оплаты Робокассы (auto-submit на стороне браузера).
// POST используется из-за объёма номенклатуры (рекомендация Робокассы): чек с кириллицей
// в URL раздувается из-за двойного URL-кодирования и упирается в лимит длины.
//
// Кодирование Receipt (подтверждено официальным SDK robokassa/sdk-php):
//   по умолчанию value = encodeURIComponent(JSON.stringify(receipt)) — URL-кодирование РОВНО один раз;
//   при ROBOKASSA_RECEIPT_RAW_SIGNATURE=true value = сырой JSON (вариант из техподдержки РК).
//   В ОБОИХ случаях одно и то же value идёт И в подпись, И в значение поля формы — браузер докодирует
//   его при submit, Робокасса декодирует обратно и проверяет подпись по value.
export function buildPaymentForm(params: {
  orderId: string
  invoiceId: string
  amount: number
  receipt?: Receipt | null
  description?: string
  email?: string
  successUrl?: string
  failUrl?: string
  platform?: string
}): { actionUrl: string; fields: Record<string, string> } {
  if (!MERCHANT_LOGIN || !PASSWORD_1) {
    throw new Error('ROBOKASSA_MERCHANT_LOGIN и ROBOKASSA_PASSWORD_1 должны быть заданы')
  }

  const { orderId, invoiceId, amount, receipt, description, email, successUrl, failUrl, platform } = params
  const outSum = amount.toFixed(2)

  const shpParams: Record<string, string> = {}
  if (platform) shpParams['Shp_platform'] = platform

  let receiptValue: string | undefined
  if (receipt && receipt.items.length > 0) {
    const json = JSON.stringify(receipt)
    receiptValue = RECEIPT_RAW_SIGN ? json : encodeURIComponent(json)
  }

  const signature = createPaymentSignature(MERCHANT_LOGIN, outSum, invoiceId, PASSWORD_1, receiptValue, shpParams)

  const fields: Record<string, string> = {
    MerchantLogin: MERCHANT_LOGIN,
    OutSum: outSum,
    InvId: invoiceId,
    SignatureValue: signature,
  }
  if (receiptValue) fields['Receipt'] = receiptValue
  if (description) fields['Description'] = description
  if (email) fields['Email'] = email
  if (successUrl) fields['SuccessURL'] = successUrl
  if (failUrl) fields['FailURL'] = failUrl
  if (IS_TEST) fields['IsTest'] = '1'
  for (const [key, value] of Object.entries(shpParams)) fields[key] = value

  logger.info({
    merchantLogin: MERCHANT_LOGIN, outSum, invoiceId, orderId, isTest: IS_TEST, platform,
    hasReceipt: !!receiptValue, receiptItems: receipt?.items.length ?? 0, rawSign: RECEIPT_RAW_SIGN
  }, 'сформирована POST-форма оплаты Робокассы')

  return { actionUrl: ROBOKASSA_URL, fields }
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
  
  // Робокасса использует оригинальный формат суммы для подписи
  // НЕ нормализуем сумму - используем как есть от Робокассы
  // Но для безопасности проверяем что это валидное число
  const outSumValue = parseFloat(outSum)
  if (!Number.isFinite(outSumValue) || outSumValue <= 0) {
    logger.error({ outSum }, 'невалидная сумма от Робокассы')
    return false
  }
  
  // фильтруем дополнительные параметры - Робокасса добавляет только параметры с префиксом Shp_
  const filteredParams: Record<string, string> = {}
  if (additionalParams) {
    for (const [key, value] of Object.entries(additionalParams)) {
      if (key.startsWith('Shp_')) {
        filteredParams[key] = value
      }
    }
  }
  
  logger.info({
    originalOutSum: outSum,
    invoiceId,
    hasAdditionalParams: Object.keys(filteredParams).length > 0,
    additionalParamsKeys: Object.keys(filteredParams),
    password2Length: PASSWORD_2.length
  }, 'проверка подписи от Робокассы')
  
  // используем оригинальный формат суммы от Робокассы
  const expectedSignature = createResultSignature(outSum, invoiceId, PASSWORD_2, filteredParams)
  
  const isValid = signature.toUpperCase() === expectedSignature
  
  if (!isValid) {
    // формируем строку для подписи (для отладки, без полного пароля)
    let debugSignatureString = `${outSum}:${invoiceId}:${PASSWORD_2.substring(0, 3)}...`
    if (Object.keys(filteredParams).length > 0) {
      const sortedKeys = Object.keys(filteredParams).sort()
      debugSignatureString += `:${sortedKeys.map(k => `${k}=${filteredParams[k]}`).join(':')}`
    }
    
    logger.warn({ 
      received: signature.toUpperCase(), 
      expected: expectedSignature,
      outSum,
      invoiceId,
      signatureString: debugSignatureString,
      password2Length: PASSWORD_2.length,
      password2FirstChars: PASSWORD_2.substring(0, 5)
    }, 'неверная подпись от Робокассы')
  }
  
  return isValid
}

// запрашиваем статус платежа через OpStateExt
// возвращает { stateCode, outSum } или null при ошибке/недоступности
// stateCode 100 = платёж проведён успешно (оплачено), 5 = инициализирован (ещё НЕ оплачен),
// 10 = отменён, 50 = средства получены (идёт зачисление), 80 = приостановлен
export async function queryOrderState(invId: string): Promise<{ stateCode: number; outSum: string } | null> {
  if (!MERCHANT_LOGIN || !PASSWORD_2) return null

  const signature = crypto
    .createHash('md5')
    .update(`${MERCHANT_LOGIN}:${invId}:${PASSWORD_2}`, 'utf8')
    .digest('hex')

  const url =
    `https://auth.robokassa.ru/Merchant/WebService/Service.asmx/OpStateExt` +
    `?MerchantLogin=${encodeURIComponent(MERCHANT_LOGIN)}` +
    `&InvoiceID=${encodeURIComponent(invId)}` +
    `&Signature=${encodeURIComponent(signature)}`

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 10_000)
    const resp = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!resp.ok) {
      logger.warn({ invId, status: resp.status }, 'OpStateExt: HTTP ошибка')
      return null
    }
    const xml = await resp.text()

    const resultCode = xml.match(/<Result>[\s\S]*?<Code>(\d+)<\/Code>/)?.[1]
    if (resultCode !== '0') {
      logger.warn({ invId, resultCode }, 'OpStateExt: результат не OK')
      return null
    }

    const stateCodeStr = xml.match(/<State>[\s\S]*?<Code>(\d+)<\/Code>/)?.[1] ?? ''
    const stateCode = parseInt(stateCodeStr, 10)
    const outSum = xml.match(/<OutSum>([^<]+)<\/OutSum>/)?.[1]?.trim() ?? ''

    if (isNaN(stateCode)) {
      logger.warn({ invId, xml: xml.slice(0, 200) }, 'OpStateExt: не удалось распарсить stateCode')
      return null
    }

    logger.info({ invId, stateCode, outSum }, 'OpStateExt: статус получен')
    return { stateCode, outSum }
  } catch (e: any) {
    logger.warn({ invId, error: e?.message }, 'OpStateExt: ошибка запроса')
    return null
  }
}

// экспортируем константы для использования в других модулях
export { IS_TEST, MERCHANT_LOGIN }

