import { google } from 'googleapis'
import { getAuthFromEnv, getSheetIdByName } from './sheets-utils.js'
import pino from 'pino'

const logger = pino()

export type Promocode = {
  code: string // код промокода (уникальный)
  type: 'amount' | 'percent' // тип: сумма или процент
  value: number // значение (сумма в рублях или процент)
  expiresAt?: string // дата окончания в формате ISO (YYYY-MM-DDTHH:mm:ss)
  active: boolean // активен ли промокод
  productSlugs?: string[] // массив slug'ов товаров, для которых действует промокод (если пусто или null - действует на все товары)
  source?: string // источник: 'certificate' для сертификатных промокодов
  maxUses?: number // лимит использований (не задан — без ограничения)
  usedCount?: number // сколько раз применён в оплаченных заказах (считает бэкенд)
}

// получение структуры заголовков листа промокодов
export async function getPromocodesHeaders(
  auth: any,
  sheetId: string
): Promise<{ headers: string[], headerIndex: Record<string, number> }> {
  const sheets = google.sheets({ version: 'v4', auth })
  const range = 'promocodes!A1:K1'
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
  const rows = res.data.values ?? []
  
  const defaultHeaders = ['code', 'type', 'value', 'expires_at', 'active', 'product_slugs', 'source', 'max_uses', 'used_count']
  let headers: string[] = []
  const headerIndex: Record<string, number> = {}

  if (rows.length > 0) {
    headers = rows[0].map((h: string) => h.trim().toLowerCase())
  } else {
    // если заголовков нет, создаем их
    headers = defaultHeaders
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'promocodes!A1:K1',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [defaultHeaders]
      }
    })
  }

  defaultHeaders.forEach(h => {
    const idx = headers.indexOf(h)
    if (idx !== -1) {
      headerIndex[h] = idx
    }
  })
  
  return { headers, headerIndex }
}

// чтение всех промокодов
export async function fetchPromocodesFromSheet(sheetId: string): Promise<Promocode[]> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })
  
  try {
    const range = 'promocodes!A2:K1000'
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
    const rows = res.data.values ?? []
    
    if (rows.length === 0) return []
    
    const { headerIndex } = await getPromocodesHeaders(auth, sheetId)
    const out: Promocode[] = []
    
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      if (!r || r.length === 0) continue
      
      const get = (n: string) => headerIndex[n] !== undefined ? (r[headerIndex[n]] ?? '') : ''
      const code = String(get('code') || '').trim().toUpperCase()
      const type = String(get('type') || '').trim().toLowerCase()
      const valueRaw = String(get('value') || '').trim()
      const expiresAtRaw = String(get('expires_at') || '').trim()
      const activeVal = String(get('active') || '').toLowerCase()
      const productSlugsRaw = String(get('product_slugs') || '').trim()
      const sourceRaw = String(get('source') || '').trim()
      const maxUsesRaw = String(get('max_uses') || '').trim()
      const usedCountRaw = String(get('used_count') || '').trim()

      if (!code) continue
      
      if (type !== 'amount' && type !== 'percent') continue
      
      const value = Number(valueRaw.replace(',', '.'))
      if (!Number.isFinite(value) || value <= 0) continue
      
      if (type === 'percent' && value > 100) continue
      
      const active = activeVal === 'true' || activeVal === '1' || activeVal === 'yes'
      
      let expiresAt: string | undefined = undefined
      if (expiresAtRaw) {
        try {
          const date = new Date(expiresAtRaw)
          if (!isNaN(date.getTime())) {
            expiresAt = date.toISOString()
          }
        } catch (e) {
          // игнорируем ошибки парсинга даты
        }
      }
      
      // парсим productSlugs (разделенные запятыми или пробелами)
      let productSlugs: string[] | undefined = undefined
      if (productSlugsRaw) {
        productSlugs = productSlugsRaw
          .split(/[,\s]+/)
          .map(s => s.trim())
          .filter(s => s.length > 0)
        if (productSlugs.length === 0) {
          productSlugs = undefined
        }
      }
      
      const maxUsesParsed = maxUsesRaw ? Number(maxUsesRaw.replace(',', '.')) : NaN
      const maxUses = Number.isFinite(maxUsesParsed) && maxUsesParsed > 0
        ? Math.floor(maxUsesParsed)
        : undefined

      const usedCountParsed = usedCountRaw ? Number(usedCountRaw.replace(',', '.')) : NaN
      const usedCount = Number.isFinite(usedCountParsed) && usedCountParsed > 0
        ? Math.floor(usedCountParsed)
        : 0

      out.push({
        code,
        type: type as 'amount' | 'percent',
        value,
        expiresAt,
        active,
        productSlugs,
        ...(sourceRaw ? { source: sourceRaw } : {}),
        ...(maxUses !== undefined ? { maxUses } : {}),
        usedCount
      })
    }
    
    return out
  } catch (e: any) {
    logger.warn({ error: e?.message }, 'не удалось прочитать лист promocodes')
    return []
  }
}

// добавление промокода
export async function appendPromocodeToSheet(
  auth: any,
  sheetId: string,
  promocode: Promocode
): Promise<void> {
  const sheets = google.sheets({ version: 'v4', auth })
  const { headers, headerIndex } = await getPromocodesHeaders(auth, sheetId)
  
  const row: any[] = new Array(headers.length).fill('')
  
  if (headerIndex.code !== undefined) row[headerIndex.code] = promocode.code.toUpperCase()
  if (headerIndex.type !== undefined) row[headerIndex.type] = promocode.type
  if (headerIndex.value !== undefined) row[headerIndex.value] = promocode.value
  if (headerIndex.expires_at !== undefined) {
    row[headerIndex.expires_at] = promocode.expiresAt 
      ? new Date(promocode.expiresAt).toISOString().slice(0, 19).replace('T', ' ')
      : ''
  }
  if (headerIndex.active !== undefined) row[headerIndex.active] = promocode.active ? 1 : 0
  if (headerIndex.product_slugs !== undefined) {
    row[headerIndex.product_slugs] = promocode.productSlugs && promocode.productSlugs.length > 0
      ? promocode.productSlugs.join(', ')
      : ''
  }
  if (headerIndex.source !== undefined) row[headerIndex.source] = promocode.source ?? ''
  if (headerIndex.max_uses !== undefined) row[headerIndex.max_uses] = promocode.maxUses ?? ''
  if (headerIndex.used_count !== undefined) row[headerIndex.used_count] = promocode.usedCount ?? 0

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'promocodes!A:Z',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row]
    }
  })
  
  logger.info({ code: promocode.code }, 'промокод добавлен в Google Sheets')
}

// удаление промокода
export async function deletePromocodeFromSheet(
  auth: any,
  sheetId: string,
  code: string
): Promise<void> {
  const sheets = google.sheets({ version: 'v4', auth })
  const range = 'promocodes!A2:K1000'
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
  const rows = res.data.values ?? []
  
  if (rows.length === 0) {
    throw new Error('Промокод не найден')
  }
  
  const { headerIndex } = await getPromocodesHeaders(auth, sheetId)
  const codeIndex = headerIndex.code
  
  if (codeIndex === undefined) {
    throw new Error('Колонка code не найдена')
  }
  
  const normalizedCode = code.trim().toUpperCase()
  let rowIndex = -1
  
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][codeIndex] || '').trim().toUpperCase() === normalizedCode) {
      rowIndex = i + 2 // +2 потому что первая строка - заголовок, и индексация с 1
      break
    }
  }
  
  if (rowIndex === -1) {
    throw new Error('Промокод не найден')
  }
  
  const sheetIdNum = await getSheetIdByName(auth, sheetId, 'promocodes')
  
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetIdNum,
            dimension: 'ROWS',
            startIndex: rowIndex - 1,
            endIndex: rowIndex
          }
        }
      }]
    }
  })
  
  logger.info({ code }, 'промокод удален из Google Sheets')
}

// обновление промокода
export async function updatePromocodeInSheet(
  auth: any,
  sheetId: string,
  oldCode: string,
  promocode: Promocode
): Promise<void> {
  const sheets = google.sheets({ version: 'v4', auth })
  const range = 'promocodes!A2:K1000'
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
  const rows = res.data.values ?? []

  if (rows.length === 0) {
    throw new Error('Промокод не найден')
  }

  const { headers, headerIndex } = await getPromocodesHeaders(auth, sheetId)
  const codeIndex = headerIndex.code

  if (codeIndex === undefined) {
    throw new Error('Колонка code не найдена')
  }

  const normalizedOldCode = oldCode.trim().toUpperCase()
  let rowIndex = -1

  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][codeIndex] || '').trim().toUpperCase() === normalizedOldCode) {
      rowIndex = i + 2 // +2 потому что первая строка - заголовок, и индексация с 1
      break
    }
  }

  if (rowIndex === -1) {
    throw new Error('Промокод не найден')
  }

  // создаем строку с обновленными данными
  const row: any[] = new Array(headers.length).fill('')

  if (headerIndex.code !== undefined) row[headerIndex.code] = promocode.code.toUpperCase()
  if (headerIndex.type !== undefined) row[headerIndex.type] = promocode.type
  if (headerIndex.value !== undefined) row[headerIndex.value] = promocode.value
  if (headerIndex.expires_at !== undefined) {
    row[headerIndex.expires_at] = promocode.expiresAt
      ? new Date(promocode.expiresAt).toISOString().slice(0, 19).replace('T', ' ')
      : ''
  }
  if (headerIndex.active !== undefined) row[headerIndex.active] = promocode.active ? 1 : 0
  if (headerIndex.product_slugs !== undefined) {
    row[headerIndex.product_slugs] = promocode.productSlugs && promocode.productSlugs.length > 0
      ? promocode.productSlugs.join(', ')
      : ''
  }
  // source и used_count принадлежат бэкенду, а не форме редактирования: переносим
  // их из существующей строки, иначе правка промокода стёрла бы признак сертификата
  // и обнулила бы счётчик использований.
  const existingRow = rows[rowIndex - 2] ?? []
  if (headerIndex.source !== undefined) {
    row[headerIndex.source] = promocode.source ?? String(existingRow[headerIndex.source] ?? '')
  }
  if (headerIndex.max_uses !== undefined) row[headerIndex.max_uses] = promocode.maxUses ?? ''
  if (headerIndex.used_count !== undefined) {
    row[headerIndex.used_count] = String(existingRow[headerIndex.used_count] ?? '') || 0
  }

  // обновляем строку
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `promocodes!A${rowIndex}:K${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row]
    }
  })
  
  logger.info({ oldCode, newCode: promocode.code }, 'промокод обновлен в Google Sheets')
}

