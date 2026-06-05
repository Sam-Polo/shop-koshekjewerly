import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('dotenv/config', () => ({}))

// googleapis mock — считаем вызовы к Sheets API
const { sheetsGetMock, valuesGetMock } = vi.hoisted(() => ({
  sheetsGetMock: vi.fn(),
  valuesGetMock: vi.fn(),
}))

vi.mock('googleapis', () => ({
  google: {
    auth: { JWT: vi.fn().mockImplementation(() => ({})) },
    sheets: vi.fn().mockReturnValue({
      spreadsheets: {
        get: sheetsGetMock,
        values: { get: valuesGetMock, update: vi.fn(), append: vi.fn() },
        batchUpdate: vi.fn(),
      },
    }),
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue('{}'),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn().mockReturnValue('{}'),
  writeFileSync: vi.fn(),
}))

// settings: spreadsheets.get (проверка листа) + values.get (чтение строк)
// categories: только values.get
function mockSettingsSheet() {
  sheetsGetMock.mockResolvedValue({
    data: { sheets: [{ properties: { title: 'settings' } }] },
  })
  valuesGetMock.mockResolvedValue({ data: { values: [['key', 'value']] } })
}

function mockCategoriesSheet() {
  valuesGetMock.mockResolvedValue({ data: { values: [] } })
}

const SHEET_ID = 'sheet123'

describe('getCachedOrdersSettings', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    sheetsGetMock.mockReset()
    valuesGetMock.mockReset()
    process.env.GOOGLE_SA_JSON = JSON.stringify({
      client_email: 'test@test.iam.gserviceaccount.com',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
    })
    process.env.IMPORT_SHEET_ID = SHEET_ID
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.GOOGLE_SA_JSON
    delete process.env.IMPORT_SHEET_ID
    delete process.env.SETTINGS_CACHE_TTL_SECONDS
  })

  it('первый вызов обращается к Sheets', async () => {
    mockSettingsSheet()
    const { getCachedOrdersSettings } = await import('./settings.js')

    await getCachedOrdersSettings(SHEET_ID)

    expect(sheetsGetMock).toHaveBeenCalledTimes(1)
  })

  it('второй вызов в пределах TTL не обращается к Sheets', async () => {
    mockSettingsSheet()
    const { getCachedOrdersSettings } = await import('./settings.js')

    await getCachedOrdersSettings(SHEET_ID)
    await getCachedOrdersSettings(SHEET_ID)

    expect(sheetsGetMock).toHaveBeenCalledTimes(1)
  })

  it('вызов после истечения TTL снова обращается к Sheets', async () => {
    process.env.SETTINGS_CACHE_TTL_SECONDS = '60'
    mockSettingsSheet()
    const { getCachedOrdersSettings } = await import('./settings.js')

    await getCachedOrdersSettings(SHEET_ID)
    vi.advanceTimersByTime(61_000)
    mockSettingsSheet() // повторно, чтобы второй вызов не упал
    await getCachedOrdersSettings(SHEET_ID)

    expect(sheetsGetMock).toHaveBeenCalledTimes(2)
  })

  it('invalidateSettingsCache сбрасывает кэш', async () => {
    mockSettingsSheet()
    const { getCachedOrdersSettings, invalidateSettingsCache } = await import('./settings.js')

    await getCachedOrdersSettings(SHEET_ID)
    invalidateSettingsCache()
    mockSettingsSheet()
    await getCachedOrdersSettings(SHEET_ID)

    expect(sheetsGetMock).toHaveBeenCalledTimes(2)
  })
})

describe('getCachedCategories', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    sheetsGetMock.mockReset()
    valuesGetMock.mockReset()
    process.env.GOOGLE_SA_JSON = JSON.stringify({
      client_email: 'test@test.iam.gserviceaccount.com',
      private_key: '-----BEGIN RSA PRIVATE KEY-----\ntest\n-----END RSA PRIVATE KEY-----',
    })
    process.env.IMPORT_SHEET_ID = SHEET_ID
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.GOOGLE_SA_JSON
    delete process.env.IMPORT_SHEET_ID
    delete process.env.CATEGORIES_CACHE_TTL_SECONDS
  })

  it('первый вызов обращается к Sheets', async () => {
    mockCategoriesSheet()
    const { getCachedCategories } = await import('./categories.js')

    await getCachedCategories(SHEET_ID)

    expect(valuesGetMock).toHaveBeenCalledTimes(1)
  })

  it('второй вызов в пределах TTL не обращается к Sheets', async () => {
    mockCategoriesSheet()
    const { getCachedCategories } = await import('./categories.js')

    await getCachedCategories(SHEET_ID)
    await getCachedCategories(SHEET_ID)

    expect(valuesGetMock).toHaveBeenCalledTimes(1)
  })

  it('вызов после TTL снова обращается к Sheets', async () => {
    process.env.CATEGORIES_CACHE_TTL_SECONDS = '60'
    mockCategoriesSheet()
    const { getCachedCategories } = await import('./categories.js')

    await getCachedCategories(SHEET_ID)
    vi.advanceTimersByTime(61_000)
    mockCategoriesSheet()
    await getCachedCategories(SHEET_ID)

    expect(valuesGetMock).toHaveBeenCalledTimes(2)
  })

  it('invalidateCategoriesCache сбрасывает кэш', async () => {
    mockCategoriesSheet()
    const { getCachedCategories, invalidateCategoriesCache } = await import('./categories.js')

    await getCachedCategories(SHEET_ID)
    invalidateCategoriesCache()
    mockCategoriesSheet()
    await getCachedCategories(SHEET_ID)

    expect(valuesGetMock).toHaveBeenCalledTimes(2)
  })
})
