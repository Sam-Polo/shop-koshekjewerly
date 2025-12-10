import { google } from 'googleapis'
import fs from 'node:fs'

export type OrdersSettings = {
  ordersClosed: boolean
  closeDate?: string
}

function getAuthFromEnv() {
  // можно указать GOOGLE_SA_FILE=путь/к/sa.json или GOOGLE_SA_JSON=строкой
  const saFile = process.env.GOOGLE_SA_FILE
  const saJson = process.env.GOOGLE_SA_JSON
  
  if (saJson) {
    try {
      return JSON.parse(saJson)
    } catch (e) {
      throw new Error('не удалось распарсить GOOGLE_SA_JSON')
    }
  }
  
  if (saFile) {
    if (!fs.existsSync(saFile)) {
      throw new Error(`файл ${saFile} не найден`)
    }
    return JSON.parse(fs.readFileSync(saFile, 'utf-8'))
  }
  
  throw new Error('GOOGLE_SA_FILE или GOOGLE_SA_JSON должны быть заданы')
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
      // если листа нет, возвращаем значения по умолчанию
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
      const value = String(row[1] || '').trim().toLowerCase()
      
      // поддерживаем оба варианта ключа (orders_closed и order_closed)
      if (key === 'orders_closed' || key === 'order_closed') {
        settings.ordersClosed = value === 'true' || value === '1' || value === 'yes'
        console.log(`[settings] найдена настройка ${key} = ${value}, ordersClosed = ${settings.ordersClosed}`)
      } else if (key === 'close_date') {
        // для даты берем оригинальное значение (не lowercase)
        const originalValue = String(row[1] || '').trim()
        if (originalValue) {
          settings.closeDate = originalValue
        }
      }
    }
    
    console.log(`[settings] итоговые настройки: ordersClosed=${settings.ordersClosed}, closeDate=${settings.closeDate || 'нет'}`)
    return settings
  } catch (error: any) {
    console.error('ошибка чтения настроек заказов:', error?.message)
    // возвращаем значения по умолчанию при ошибке
    return { ordersClosed: false }
  }
}


