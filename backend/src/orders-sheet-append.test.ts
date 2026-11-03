import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Запись заказа в лист orders — самый важный путь файла: строка заказа не должна
// зависеть от новых колонок EMS (AD, AE). До 04.11.2026 сетка листа была ровно 29
// колонок (A..AC), а ячейку за краем сетки Sheets отклоняет.

vi.mock('dotenv/config', () => ({}))

const g = vi.hoisted(() => ({
  get: vi.fn(),
  batchUpdate: vi.fn(),
  valuesGet: vi.fn(),
  valuesUpdate: vi.fn(),
  valuesAppend: vi.fn(),
  sendAlert: vi.fn(async (..._a: any[]) => {}),
}))

vi.mock('googleapis', () => ({
  google: {
    auth: { JWT: vi.fn().mockImplementation(() => ({})) },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        get: g.get,
        batchUpdate: g.batchUpdate,
        values: { get: g.valuesGet, update: g.valuesUpdate, append: g.valuesAppend },
      },
    }),
  },
}))
vi.mock('./store.js', () => ({ listProducts: vi.fn().mockReturnValue([]) }))
vi.mock('./alerts.js', () => ({ sendAlert: g.sendAlert }))

const META = {
  data: {
    sheets: [
      { properties: { title: 'orders', sheetId: 11, gridProperties: { columnCount: 29 } } },
      { properties: { title: 'order_items', sheetId: 12, gridProperties: { columnCount: 26 } } },
    ],
  },
}

function makeOrder(deliveryMethod: 'ems' | 'cdek') {
  return {
    orderId: 'ORD-1',
    status: 'pending' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    platform: 'telegram' as const,
    customerChatId: '1',
    orderData: {
      items: [{ slug: 'braslet', title: 'Браслет', price: 9990, quantity: 1 }],
      fullName: 'Petrov Ivan', phone: '+998900000000', country: 'Узбекистан', city: 'Tashkent',
      address: '100000, Tashkent, Street 1', deliveryRegion: '', deliveryCost: 1281, total: 11271,
      deliveryMethod,
      ...(deliveryMethod === 'ems'
        ? { recipientCountry: 'Узбекистан', recipientCountryCode: 860, recipientCity: 'Tashkent', recipientStreet: 'Street 1', recipientIndex: '100000' }
        : {}),
    },
  }
}

let sheetMod: typeof import('./orders-sheet.js')

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  process.env.IMPORT_SHEET_ID = 'sheet123'
  process.env.GOOGLE_SA_JSON = JSON.stringify({ client_email: 'a@b', private_key: 'k' })
  g.get.mockResolvedValue(META)
  g.batchUpdate.mockResolvedValue({})
  // заголовки: старые 29 — новые две колонки ещё не подписаны
  g.valuesGet.mockResolvedValue({ data: { values: [['order_id']] } })
  g.valuesUpdate.mockResolvedValue({})
  g.valuesAppend.mockResolvedValue({ data: { updates: { updatedRange: 'orders!A1642:AB1642' } } })
  sheetMod = await import('./orders-sheet.js')
})

afterEach(() => {
  delete process.env.IMPORT_SHEET_ID
  delete process.env.GOOGLE_SA_JSON
})

describe('appendOrderToSheet и колонки EMS', () => {
  it('расширяет сетку orders под новые колонки до записи заголовков', async () => {
    await sheetMod.appendOrderToSheet(makeOrder('cdek') as any)
    expect(g.batchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      requestBody: { requests: [{ appendDimension: { sheetId: 11, dimension: 'COLUMNS', length: 2 } }] },
    }))
    // сетка order_items (26) шире её заголовков (8) — не трогаем
    expect(g.batchUpdate).toHaveBeenCalledTimes(1)
  })

  it('строка заказа — прежние 28 значений; адрес EMS — отдельной записью в AD той же строки', async () => {
    await sheetMod.appendOrderToSheet(makeOrder('ems') as any)
    const orderAppend = g.valuesAppend.mock.calls.find(c => c[0].range === 'orders!A:Y')!
    expect(orderAppend[0].requestBody.values[0]).toHaveLength(28)
    const adWrite = g.valuesUpdate.mock.calls.find(c => c[0].range === 'orders!AD1642')
    expect(adWrite).toBeTruthy()
    expect(JSON.parse(adWrite![0].requestBody.values[0][0])).toMatchObject({ countryCode: 860, city: 'Tashkent' })
  })

  it('СДЭК-заказ в AD ничего не пишет', async () => {
    await sheetMod.appendOrderToSheet(makeOrder('cdek') as any)
    expect(g.valuesUpdate.mock.calls.some(c => String(c[0].range).startsWith('orders!AD'))).toBe(false)
  })

  it('сбой расширения сетки не мешает записать заказ', async () => {
    g.batchUpdate.mockRejectedValue(new Error('quota'))
    await sheetMod.appendOrderToSheet(makeOrder('cdek') as any)
    expect(g.valuesAppend).toHaveBeenCalledWith(expect.objectContaining({ range: 'orders!A:Y' }))
    expect(g.valuesAppend).toHaveBeenCalledWith(expect.objectContaining({ range: 'order_items!A:H' }))
    expect(g.sendAlert).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code: 'SHEETS_LAYOUT_UPDATE_FAILED' }))
  })

  it('сбой записи адреса EMS не мешает записать позиции заказа', async () => {
    g.valuesUpdate.mockImplementation(async (req: any) => {
      if (String(req.range).startsWith('orders!AD')) throw new Error('exceeds grid limits')
      return {}
    })
    await sheetMod.appendOrderToSheet(makeOrder('ems') as any)
    expect(g.valuesAppend).toHaveBeenCalledWith(expect.objectContaining({ range: 'order_items!A:H' }))
    expect(g.sendAlert).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code: 'EMS_RECIPIENT_WRITE_FAILED' }))
  })
})
