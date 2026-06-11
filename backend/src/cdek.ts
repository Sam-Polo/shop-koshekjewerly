import type { Order } from './orders.js'
import { sendAlert } from './alerts.js'

const CDEK_BASE = (process.env.CDEK_BASE_URL ?? 'https://api.cdek.ru/v2').replace(/\/$/, '')
// CDEK city code for Moscow (official CDEK reference)
const FROM_CITY_CODE = Number(process.env.CDEK_FROM_CITY_CODE ?? 44)
const TARIFF_CODE = 136
const PKG_WEIGHT_G = 200
const PKG_LENGTH_CM = 15
const PKG_WIDTH_CM = 15
const PKG_HEIGHT_CM = 5

// ── Token cache ───────────────────────────────────────────────────────────────

let _cachedToken: string | null = null
let _tokenExpiresAt = 0

// exported for tests
export function _resetTokenCache() {
  _cachedToken = null
  _tokenExpiresAt = 0
}

export async function getToken(): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiresAt - 60_000) return _cachedToken

  const clientId = process.env.CDEK_CLIENT_ID
  const clientSecret = process.env.CDEK_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('CDEK_CLIENT_ID / CDEK_CLIENT_SECRET not set')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(
      `${CDEK_BASE}/oauth/token?grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`,
      { method: 'POST', signal: ctrl.signal }
    )
    clearTimeout(timer)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`CDEK token HTTP ${resp.status}: ${text.slice(0, 200)}`)
    }
    const data = await resp.json()
    if (!data?.access_token) throw new Error('CDEK token: no access_token in response')
    _cachedToken = data.access_token as string
    _tokenExpiresAt = Date.now() + ((data.expires_in as number) ?? 3600) * 1000
    return _cachedToken
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── Authenticated fetch ───────────────────────────────────────────────────────

export async function cdekFetch(method: string, path: string, body?: unknown): Promise<unknown> {
  const token = await getToken()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const resp = await fetch(`${CDEK_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`CDEK ${method} ${path} → HTTP ${resp.status}: ${text.slice(0, 300)}`)
    }
    return resp.json()
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── City search ───────────────────────────────────────────────────────────────

export interface CdekCity {
  code: number
  city: string
  region?: string
  country_code?: string
}

export async function searchCities(query: string): Promise<CdekCity[]> {
  // /location/suggest/cities does prefix (autocomplete) matching; /location/cities?city= does exact match
  // Response format: { code, full_name: "City, Region, Country" | "City, Country", country_code }
  const params = new URLSearchParams({ name: query, lang: 'rus', size: '10' })
  const data = await cdekFetch('GET', `/location/suggest/cities?${params}`) as any[]
  if (!Array.isArray(data)) return []
  return data.map((c: any) => {
    const parts = ((c.full_name as string) ?? '').split(', ')
    const city = parts[0] ?? ''
    const region = parts.length >= 3 ? parts[1] : undefined
    return { code: c.code as number, city, region, country_code: c.country_code as string | undefined }
  })
}

// ── Pickup points (ПВЗ) ───────────────────────────────────────────────────────

export interface CdekPvz {
  code: string
  name: string
  address: string
  work_time?: string
}

export async function getPickupPoints(cityCode: number): Promise<CdekPvz[]> {
  const params = new URLSearchParams({ city_code: String(cityCode), type: 'PVZ', is_handout: 'true' })
  const data = await cdekFetch('GET', `/deliverypoints?${params}`) as any[]
  if (!Array.isArray(data)) return []
  return data.map((p: any) => ({
    code: p.code as string,
    name: p.name as string,
    address: (p.location?.address ?? p.location?.city ?? '') as string,
    work_time: p.work_time as string | undefined,
  }))
}

// ── Delivery cost calculator ──────────────────────────────────────────────────

export async function calculateDelivery(toCityCode: number): Promise<number> {
  const data = await cdekFetch('POST', '/calculator/tariff', {
    tariff_code: TARIFF_CODE,
    from_location: { code: FROM_CITY_CODE },
    to_location: { code: toCityCode },
    packages: [{ weight: PKG_WEIGHT_G, length: PKG_LENGTH_CM, width: PKG_WIDTH_CM, height: PKG_HEIGHT_CM }],
  }) as any
  const sum = data?.delivery_sum ?? data?.total_sum
  if (typeof sum !== 'number') {
    const errors = data?.errors ?? data?.error
    throw new Error(`CDEK calculator: no delivery_sum. Response: ${JSON.stringify(errors ?? data).slice(0, 300)}`)
  }
  return Math.ceil(sum)
}

// ── Create order ──────────────────────────────────────────────────────────────

export interface CdekOrderResult {
  uuid: string
  cdekNumber: string | null
}

export async function createCdekOrder(order: Order, pvzCode: string): Promise<CdekOrderResult> {
  const items = order.orderData.items.map((item, idx) => ({
    name: item.title.slice(0, 255),
    ware_key: (item.slug ?? `item-${idx}`).slice(0, 20),
    payment: { value: 0 },
    cost: item.price,
    amount: item.quantity,
    weight: Math.max(10, Math.round(PKG_WEIGHT_G / order.orderData.items.length)),
  }))

  const data = await cdekFetch('POST', '/orders', {
    tariff_code: TARIFF_CODE,
    comment: `Заказ ${order.orderId}`,
    from_location: { code: FROM_CITY_CODE },
    delivery_point: pvzCode,
    recipient: {
      name: order.orderData.fullName,
      phones: [{ number: order.orderData.phone }],
    },
    packages: [{
      number: order.orderId.slice(0, 40),
      weight: PKG_WEIGHT_G,
      length: PKG_LENGTH_CM,
      width: PKG_WIDTH_CM,
      height: PKG_HEIGHT_CM,
      items,
    }],
  }) as any

  const uuid = data?.entity?.uuid as string | undefined
  if (!uuid) {
    const errors = data?.requests?.[0]?.errors
    throw new Error(`CDEK createOrder: no uuid. Errors: ${JSON.stringify(errors)}`)
  }

  return { uuid, cdekNumber: (data?.entity?.cdek_number as string) ?? null }
}

// ── Get track number ──────────────────────────────────────────────────────────

export async function getCdekTrackNumber(uuid: string): Promise<string | null> {
  const data = await cdekFetch('GET', `/orders/${uuid}`) as any
  return (data?.entity?.cdek_number as string) ?? null
}

// ── Get order UUID by track number ────────────────────────────────────────────

export async function getCdekUuidByTrack(cdekNumber: string): Promise<string | null> {
  const data = await cdekFetch('GET', `/orders?cdek_number=${encodeURIComponent(cdekNumber)}`) as any
  return (data?.entity?.uuid as string) ?? null
}

// ── Download barcode H6 (PDF) ─────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

export async function downloadCdekBarcode(orderUuid: string): Promise<Buffer> {
  // step 1: create print task
  const task = await cdekFetch('POST', '/print/barcodes', {
    orders: [{ order_uuid: orderUuid }],
    format: 'H6',
    lang_type: 'RUS',
  }) as any
  const taskUuid = task?.entity?.uuid as string | undefined
  if (!taskUuid) throw new Error(`CDEK barcode: no task uuid, response: ${JSON.stringify(task).slice(0, 300)}`)

  // step 2: poll until url is ready (up to 10 attempts × 2s)
  let downloadUrl: string | null = null
  for (let i = 0; i < 10; i++) {
    await sleep(2_000)
    const status = await cdekFetch('GET', `/print/barcodes/${taskUuid}`) as any
    const url = status?.entity?.url as string | undefined
    if (url) { downloadUrl = url; break }
  }
  if (!downloadUrl) throw new Error(`CDEK barcode: task ${taskUuid} did not produce a URL after 20s`)

  // step 3: download the file
  const token = await getToken()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const resp = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (!resp.ok) throw new Error(`CDEK barcode download HTTP ${resp.status}`)
    const buf = await resp.arrayBuffer()
    return Buffer.from(buf)
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
}

// ── High-level: create order with retry + async track polling ─────────────────

const RETRY_DELAYS_MS = [2_000, 4_000]

export async function triggerCdekOrderAsync(
  order: Order,
  onTrackReady: (uuid: string, cdekNumber: string) => Promise<void>
): Promise<void> {
  const pvzCode = order.orderData.pvzCode
  if (!pvzCode) {
    sendAlert(
      `CDEK: pvzCode не задан для заказа ${order.orderId}`,
      { tag: 'cdek', level: 'high', hint: 'заказ не был создан в CDEK — менеджер должен создать вручную', code: 'CDEK_NO_PVZ' }
    ).catch(() => {})
    return
  }

  // create order with up to 3 attempts
  let result: CdekOrderResult | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await createCdekOrder(order, pvzCode)
      break
    } catch (e: any) {
      if (attempt < 3) {
        await sleep(RETRY_DELAYS_MS[attempt - 1])
      } else {
        sendAlert(
          `CDEK: не удалось создать заказ ${order.orderId} после 3 попыток: ${e?.message}`,
          { tag: 'cdek', level: 'high', hint: 'менеджер должен создать заказ в CDEK вручную', code: 'CDEK_ORDER_CREATE_FAILED' }
        ).catch(() => {})
        return
      }
    }
  }

  if (!result) return

  let cdekNumber = result.cdekNumber

  // if cdek_number not assigned yet, poll up to 5 times with 5s interval
  if (!cdekNumber) {
    for (let i = 0; i < 5; i++) {
      await sleep(5_000)
      try {
        cdekNumber = await getCdekTrackNumber(result.uuid)
        if (cdekNumber) break
      } catch {}
    }
  }

  if (cdekNumber) {
    await onTrackReady(result.uuid, cdekNumber).catch((e: any) => {
      sendAlert(
        `CDEK: трек ${cdekNumber} получен для ${order.orderId}, но onTrackReady упал: ${e?.message}`,
        { tag: 'cdek', level: 'moderate', code: 'CDEK_TRACK_CALLBACK_FAILED' }
      ).catch(() => {})
    })
  } else {
    sendAlert(
      `CDEK: заказ ${order.orderId} создан (uuid=${result.uuid}), cdek_number не присвоен за 25с. Трек придёт позже.`,
      { tag: 'cdek', level: 'info', hint: 'проверьте трек в ЛК CDEK через несколько минут', code: 'CDEK_NO_TRACK_YET' }
    ).catch(() => {})
  }
}
