import { google } from 'googleapis'
import fs from 'node:fs'

export type BannerSettings = {
  bannerEnabled: boolean
  bannerText: string
  bannerStyle: 'pink' | 'gold' | 'neutral'
  bannerDateFrom?: string
  bannerDateTo?: string
}

export type OrdersSettings = {
  ordersClosed: boolean
  closeDate?: string
  assemblyMessage?: string
  priorityOrderEnabled?: boolean
  banner?: BannerSettings
}

function getAuthFromEnv() {
  // можно указать GOOGLE_SA_FILE=путь/к/sa.json или GOOGLE_SA_JSON=строкой
  const filePath = process.env.GOOGLE_SA_FILE
  const raw = process.env.GOOGLE_SA_JSON
  let creds: any

  if (filePath) {
    const txt = fs.readFileSync(filePath, 'utf8')
    creds = JSON.parse(txt)
  } else if (raw) {
    creds = JSON.parse(raw)
  } else {
    throw new Error('GOOGLE_SA_JSON or GOOGLE_SA_FILE is required')
  }

  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly']
  return new google.auth.JWT(creds.client_email, undefined, creds.private_key, scopes)
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

    // читаем настройки (расширен диапазон для баннера)
    const range = 'settings!A1:B20'
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range })
    const rows = res.data.values ?? []

    if (rows.length === 0) {
      return { ordersClosed: false }
    }

    // парсим настройки из таблицы (первая строка - заголовки)
    const settings: OrdersSettings = { ordersClosed: false }
    const banner: BannerSettings = {
      bannerEnabled: false,
      bannerText: '',
      bannerStyle: 'neutral'
    }
    let hasBannerData = false

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row || row.length < 2) continue

      const key = String(row[0] || '').trim().toLowerCase()
      const value = String(row[1] || '').trim().toLowerCase()
      const originalValue = String(row[1] || '').trim()

      // поддерживаем оба варианта ключа (orders_closed и order_closed)
      if (key === 'orders_closed' || key === 'order_closed') {
        settings.ordersClosed = value === 'true' || value === '1' || value === 'yes'
        console.log(`[settings] найдена настройка ${key} = ${value}, ordersClosed = ${settings.ordersClosed}`)
      } else if (key === 'close_date') {
        if (originalValue) {
          settings.closeDate = originalValue
        }
      } else if (key === 'assembly_message') {
        if (originalValue) {
          settings.assemblyMessage = originalValue
        }
      } else if (key === 'priority_order_enabled') {
        // отсутствие ключа = включено (обратная совместимость)
        settings.priorityOrderEnabled = !(value === 'false' || value === '0' || value === 'no')
      } else if (key === 'banner_enabled') {
        hasBannerData = true
        banner.bannerEnabled = value === 'true' || value === '1' || value === 'yes'
      } else if (key === 'banner_text') {
        hasBannerData = true
        banner.bannerText = originalValue
      } else if (key === 'banner_style') {
        hasBannerData = true
        if (value === 'pink' || value === 'gold' || value === 'neutral') {
          banner.bannerStyle = value
        }
      } else if (key === 'banner_date_from') {
        hasBannerData = true
        if (originalValue) {
          banner.bannerDateFrom = originalValue
        }
      } else if (key === 'banner_date_to') {
        hasBannerData = true
        if (originalValue) {
          banner.bannerDateTo = originalValue
        }
      }
    }

    if (hasBannerData) {
      settings.banner = banner
    }

    console.log(`[settings] итоговые настройки: ordersClosed=${settings.ordersClosed}, bannerEnabled=${banner.bannerEnabled}`)
    return settings
  } catch (error: any) {
    console.error('ошибка чтения настроек заказов:', error?.message)
    // возвращаем значения по умолчанию при ошибке
    return { ordersClosed: false }
  }
}


