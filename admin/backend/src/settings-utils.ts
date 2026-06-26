import { google } from 'googleapis'
import { getAuthFromEnv } from './sheets-utils.js'
import pino from 'pino'

const logger = pino()

export type OrdersSettings = {
  ordersClosed: boolean
  closeDate?: string
  assemblyMessage?: string
  trackMessage?: string
  shippedMessage?: string
  assembledMessage?: string
  priorityOrderEnabled?: boolean
  priorityOrderFee?: number
}

export type BannerSettings = {
  bannerEnabled: boolean
  bannerText: string
  bannerStyle: 'pink' | 'gold' | 'neutral'
  bannerDateFrom?: string
  bannerDateTo?: string
}

async function ensureSettingsSheet(sheets: ReturnType<typeof google.sheets>, sheetId: string): Promise<void> {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
  const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === 'settings')

  if (!sheetExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: 'settings' } } }]
      }
    })

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'settings!A1:B1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['key', 'value']] }
    })
  }
}

async function readSettingsRows(sheets: ReturnType<typeof google.sheets>, sheetId: string) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'settings!A1:B25'
    })
    return res.data.values ?? []
  } catch {
    return []
  }
}

async function upsertSettingRow(
  sheets: ReturnType<typeof google.sheets>,
  sheetId: string,
  rows: any[][],
  key: string,
  value: string
): Promise<void> {
  let rowIndex = -1
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i]?.[0] || '').trim().toLowerCase() === key) {
      rowIndex = i + 1 // 1-based sheet row number
      break
    }
  }

  if (rowIndex > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `settings!B${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[value]] }
    })
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'settings!A:B',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[key, value]] }
    })
  }
}

// получение настроек заказов из Google Sheets
export async function fetchOrdersSettingsFromSheet(sheetId: string): Promise<OrdersSettings> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
    const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === 'settings')

    if (!sheetExists) {
      await ensureSettingsSheet(sheets, sheetId)
      return { ordersClosed: false }
    }

    const rows = await readSettingsRows(sheets, sheetId)
    const settings: OrdersSettings = { ordersClosed: false }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row || row.length < 2) continue

      const key = String(row[0] || '').trim().toLowerCase()
      const value = String(row[1] || '').trim().toLowerCase()
      const originalValue = String(row[1] || '').trim()

      if (key === 'orders_closed' || key === 'order_closed') {
        settings.ordersClosed = value === 'true' || value === '1' || value === 'yes'
        logger.info({ key, value, ordersClosed: settings.ordersClosed }, 'найдена настройка orders_closed')
      } else if (key === 'close_date') {
        if (originalValue) settings.closeDate = originalValue
      } else if (key === 'assembly_message') {
        if (originalValue) settings.assemblyMessage = originalValue
      } else if (key === 'track_message') {
        if (originalValue) settings.trackMessage = originalValue
      } else if (key === 'shipped_message') {
        if (originalValue) settings.shippedMessage = originalValue
      } else if (key === 'assembled_message') {
        if (originalValue) settings.assembledMessage = originalValue
      } else if (key === 'priority_order_enabled') {
        settings.priorityOrderEnabled = !(value === 'false' || value === '0' || value === 'no')
      } else if (key === 'priority_order_fee') {
        const fee = parseInt(originalValue, 10)
        if (!isNaN(fee) && fee >= 1 && fee <= 100) settings.priorityOrderFee = fee
      }
    }

    logger.info({ ordersClosed: settings.ordersClosed, closeDate: settings.closeDate }, 'настройки заказов прочитаны из таблицы')
    return settings
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка чтения настроек заказов')
    return { ordersClosed: false }
  }
}

// получение настроек баннера из Google Sheets
export async function fetchBannerSettingsFromSheet(sheetId: string): Promise<BannerSettings> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  const defaultBanner: BannerSettings = {
    bannerEnabled: false,
    bannerText: '',
    bannerStyle: 'neutral'
  }

  try {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sheetId })
    const sheetExists = spreadsheet.data.sheets?.some(s => s.properties?.title === 'settings')
    if (!sheetExists) return defaultBanner

    const rows = await readSettingsRows(sheets, sheetId)
    const banner: BannerSettings = { ...defaultBanner }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (!row || row.length < 2) continue

      const key = String(row[0] || '').trim().toLowerCase()
      const value = String(row[1] || '').trim().toLowerCase()
      const originalValue = String(row[1] || '').trim()

      if (key === 'banner_enabled') {
        banner.bannerEnabled = value === 'true' || value === '1' || value === 'yes'
      } else if (key === 'banner_text') {
        banner.bannerText = originalValue
      } else if (key === 'banner_style') {
        if (value === 'pink' || value === 'gold' || value === 'neutral') {
          banner.bannerStyle = value
        }
      } else if (key === 'banner_date_from') {
        if (originalValue) banner.bannerDateFrom = originalValue
      } else if (key === 'banner_date_to') {
        if (originalValue) banner.bannerDateTo = originalValue
      }
    }

    logger.info({ banner }, 'настройки баннера прочитаны из таблицы')
    return banner
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка чтения настроек баннера')
    return defaultBanner
  }
}

// сохранение настроек заказов в Google Sheets
export async function saveOrdersSettingsToSheet(sheetId: string, settings: OrdersSettings): Promise<void> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  try {
    await ensureSettingsSheet(sheets, sheetId)

    const rows = await readSettingsRows(sheets, sheetId)

    if (rows.length === 0 || rows[0]?.[0] !== 'key') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'settings!A1:B1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['key', 'value']] }
      })
    }

    await upsertSettingRow(sheets, sheetId, rows, 'orders_closed', settings.ordersClosed ? 'true' : 'false')
    await upsertSettingRow(sheets, sheetId, rows, 'close_date', settings.closeDate || '')
    await upsertSettingRow(sheets, sheetId, rows, 'assembly_message', settings.assemblyMessage || '')
    await upsertSettingRow(sheets, sheetId, rows, 'track_message', settings.trackMessage || '')
    await upsertSettingRow(sheets, sheetId, rows, 'shipped_message', settings.shippedMessage || '')
    await upsertSettingRow(sheets, sheetId, rows, 'assembled_message', settings.assembledMessage || '')
    await upsertSettingRow(sheets, sheetId, rows, 'priority_order_enabled', settings.priorityOrderEnabled === false ? 'false' : 'true')
    await upsertSettingRow(sheets, sheetId, rows, 'priority_order_fee', String(settings.priorityOrderFee ?? 30))

    logger.info({ ordersClosed: settings.ordersClosed, closeDate: settings.closeDate }, 'настройки заказов сохранены')
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения настроек заказов')
    throw error
  }
}

// сохранение настроек баннера в Google Sheets
export async function saveBannerSettingsToSheet(sheetId: string, banner: BannerSettings): Promise<void> {
  const auth = getAuthFromEnv()
  const sheets = google.sheets({ version: 'v4', auth })

  try {
    await ensureSettingsSheet(sheets, sheetId)

    // читаем СВЕЖИЕ строки после возможного создания листа
    const rows = await readSettingsRows(sheets, sheetId)

    if (rows.length === 0 || rows[0]?.[0] !== 'key') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: 'settings!A1:B1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['key', 'value']] }
      })
    }

    await upsertSettingRow(sheets, sheetId, rows, 'banner_enabled', banner.bannerEnabled ? 'true' : 'false')
    await upsertSettingRow(sheets, sheetId, rows, 'banner_text', banner.bannerText || '')
    await upsertSettingRow(sheets, sheetId, rows, 'banner_style', banner.bannerStyle || 'neutral')
    await upsertSettingRow(sheets, sheetId, rows, 'banner_date_from', banner.bannerDateFrom || '')
    await upsertSettingRow(sheets, sheetId, rows, 'banner_date_to', banner.bannerDateTo || '')

    logger.info({ banner }, 'настройки баннера сохранены')
  } catch (error: any) {
    logger.error({ error: error?.message }, 'ошибка сохранения настроек баннера')
    throw error
  }
}
