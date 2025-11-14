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
}

// получение структуры заголовков листа промокодов
export async function getPromocodesHeaders(
  auth: any,
  sheetId: string
): Promise<{ headers: string[], headerIndex: Record<string, number> }> {
  const sheets = google.sheets({ version: 'v4', auth })
  const range = 'promocodes!A1:F1'
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
  const rows = res.data.values ?? []
  
  const defaultHeaders = ['code', 'type', 'value', 'expires_at', 'active']
  let headers: string[] = []
  const headerIndex: Record<string, number> = {}
  
  if (rows.length > 0) {
    headers = rows[0].map((h: string) => h.trim().toLowerCase())
  } else {
    // если заголовков нет, создаем их
    headers = defaultHeaders
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'promocodes!A1:F1',
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
    const range = 'promocodes!A2:F1000'
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
      
      out.push({
        code,
        type: type as 'amount' | 'percent',
        value,
        expiresAt,
        active
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
  const range = 'promocodes!A2:F1000'
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

