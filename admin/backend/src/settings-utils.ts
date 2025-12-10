import { google } from 'googleapis'
import { getAuthFromEnv } from './sheets-utils.js'
import pino from 'pino'

const logger = pino()

export type OrdersSettings = {
  ordersClosed: boolean // закрыты ли заказы
  closeDate?: string // дата закрытия в формате YYYY-MM-DD (опционально, только для информационного сообщения)
}

// получение настроек заказов из Google Sheets
export async function fetchOrdersSettingsFromSheet(sheetId: string): Promise<OrdersSettings> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })
  
  try {
    // проверяем, существует ли лист settings
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
    const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === 'settings')
    
    if (!sheetExists) {
      // создаем лист settings с заголовками
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: 'settings'
              }
            }
          }]
        }
      })
      
      // добавляем заголовки и начальные значения
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'settings!A1:B2',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [
            ['key', 'value'],
            ['orders_closed', 'false'],
            ['close_date', '']
          ]
        }
      })
      
      return { ordersClosed: false }
    }
    
    // читаем настройки
    const range = 'settings!A1:B10'
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
    const rows = res.data.values ?? []
    
    if (rows.length === 0) {
      return { ordersClosed: false }
    }
    
    // парсим настройки из таблицы (первая строка - заголовки)
    const settings: OrdersSettings = { ordersClosed: false }
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row || row.length < 2) continue
      
      const key = String(row[0] || '').trim().toLowerCase()
      const value = String(row[1] || '').trim()
      
      if (key === 'orders_closed') {
        settings.ordersClosed = value === 'true' || value === '1' || value === 'yes'
      } else if (key === 'close_date') {
        if (value) {
          settings.closeDate = value
        }
      }
    }
    
    return settings
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка чтения настроек заказов')
    // возвращаем значения по умолчанию при ошибке
    return { ordersClosed: false }
  }
}

// сохранение настроек заказов в Google Sheets
export async function saveOrdersSettingsToSheet(sheetId: string, settings: OrdersSettings): Promise<void> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })
  
  try {
    // проверяем, существует ли лист settings
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
    const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === 'settings')
    
    if (!sheetExists) {
      // создаем лист settings
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: 'settings'
              }
            }
          }]
        }
      })
    }
    
    // обновляем значения
    // сначала обновляем заголовки, если их нет
    const headerRange = 'settings!A1:B1'
    const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: headerRange })
    const headerRows = headerRes.data.values ?? []
    
    if (headerRows.length === 0 || headerRows[0]?.[0] !== 'key') {
      // добавляем заголовки
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'settings!A1:B1',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['key', 'value']]
        }
      })
    }
    
    // обновляем значения orders_closed и close_date
    const values: string[][] = []
    
    // проверяем, есть ли уже строки с этими ключами
    const dataRange = 'settings!A1:B10'
    const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: dataRange })
    const dataRows = dataRes.data.values ?? []
    
    let ordersClosedRowIndex = -1
    let closeDateRowIndex = -1
    
    for (let i = 1; i < dataRows.length; i++) {
      const key = String(dataRows[i]?.[0] || '').trim().toLowerCase()
      if (key === 'orders_closed') {
        ordersClosedRowIndex = i + 1 // +1 потому что строки начинаются с 1 (заголовок на строке 1)
      } else if (key === 'close_date') {
        closeDateRowIndex = i + 1
      }
    }
    
    // обновляем или добавляем orders_closed
    if (ordersClosedRowIndex > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `settings!B${ordersClosedRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[settings.ordersClosed ? 'true' : 'false']]
        }
      })
    } else {
      // добавляем новую строку
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'settings!A:B',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['orders_closed', settings.ordersClosed ? 'true' : 'false']]
        }
      })
    }
    
    // обновляем или добавляем close_date
    const closeDateValue = settings.closeDate || ''
    if (closeDateRowIndex > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: `settings!B${closeDateRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[closeDateValue]]
        }
      })
    } else {
      // добавляем новую строку
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'settings!A:B',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['close_date', closeDateValue]]
        }
      })
    }
    
    logger.info({ ordersClosed: settings.ordersClosed, closeDate: settings.closeDate }, 'настройки заказов сохранены')
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения настроек заказов')
    throw error
  }
}


