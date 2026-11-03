import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Оформление EMS по кнопке «Назначить дату»: заказ при оплате только в backlog, всё
// остальное — здесь. Проверить на живой Почте без списаний это нельзя (успешный checkin
// стоит денег), поэтому порядок шагов и идемпотентность закрыты тестами целиком.

const m = vi.hoisted(() => ({
  checkRequiredPochtaEnv: vi.fn(() => true),
  createPochtaOrder: vi.fn(),
  createBatch: vi.fn(),
  getShpiFromBatch: vi.fn(),
  getBatch: vi.fn(),
  setBatchSendingDate: vi.fn(),
  checkinBatch: vi.fn(),
  downloadF103: vi.fn(async () => Buffer.from('f103')),
  downloadF7p: vi.fn(async () => Buffer.from('forms')),
  findShipmentByOrderNum: vi.fn(),
  findBacklogOrderByOrderNum: vi.fn(),
  getOrderFromSheet: vi.fn(),
  updatePochtaStateInSheet: vi.fn(async (..._a: any[]) => {}),
  updatePochtaInfoInSheet: vi.fn(async (..._a: any[]) => {}),
  updateOrderAdminNoteInSheet: vi.fn(async (..._a: any[]) => {}),
  listEmsOrdersFromSheet: vi.fn(),
  uploadBufferToS3: vi.fn(async (key: string) => `https://s3.test/${key}`),
  findLeadByOrderNumber: vi.fn(),
  updateAmoCrmLeadTrack: vi.fn(async (..._a: any[]) => {}),
  setAmoCrmLeadBarcodeUrl: vi.fn(async (..._a: any[]) => {}),
  sendAlert: vi.fn(async (..._a: any[]) => {}),
}))

vi.mock('./pochta.js', () => ({
  checkRequiredPochtaEnv: m.checkRequiredPochtaEnv,
  createPochtaOrder: m.createPochtaOrder,
  createBatch: m.createBatch,
  getShpiFromBatch: m.getShpiFromBatch,
  getBatch: m.getBatch,
  setBatchSendingDate: m.setBatchSendingDate,
  checkinBatch: m.checkinBatch,
  downloadF103: m.downloadF103,
  downloadF7p: m.downloadF7p,
  findShipmentByOrderNum: m.findShipmentByOrderNum,
  findBacklogOrderByOrderNum: m.findBacklogOrderByOrderNum,
}))
vi.mock('./orders-sheet.js', () => ({
  getOrderFromSheet: m.getOrderFromSheet,
  updatePochtaStateInSheet: m.updatePochtaStateInSheet,
  updatePochtaInfoInSheet: m.updatePochtaInfoInSheet,
  updateOrderAdminNoteInSheet: m.updateOrderAdminNoteInSheet,
  listEmsOrdersFromSheet: m.listEmsOrdersFromSheet,
}))
vi.mock('./s3.js', () => ({ uploadBufferToS3: m.uploadBufferToS3 }))
vi.mock('./amocrm.js', () => ({
  findLeadByOrderNumber: m.findLeadByOrderNumber,
  updateAmoCrmLeadTrack: m.updateAmoCrmLeadTrack,
  setAmoCrmLeadBarcodeUrl: m.setAmoCrmLeadBarcodeUrl,
}))
vi.mock('./alerts.js', () => ({ sendAlert: m.sendAlert }))

import {
  computeEmsStage, parsePochtaState, isIsoDate, moscowToday, shipEmsOrder, prepareEmsOrder,
  listEmsOrders, _resetEmsCaches, type EmsMessaging, type PochtaState,
} from './ems-shipping.js'

const TODAY = '2026-11-04'
const DATE = '2026-11-05'

function makeRow(over: Record<string, unknown> = {}) {
  return {
    orderId: 'ORD-1',
    status: 'paid',
    sheetStatus: 'paid',
    adminNote: '',
    pochtaState: JSON.stringify({ orderId: 777 }),
    pochtaShpi: null,
    createdAt: Date.parse('2026-11-04T08:00:00Z'),
    updatedAt: Date.parse('2026-11-04T08:05:00Z'),
    customerChatId: '123456',
    platform: 'telegram',
    orderData: {
      items: [{ slug: 'braslet', title: 'Браслет', price: 9990, quantity: 1 }],
      fullName: 'Petrov Ivan', phone: '+998900000000',
      country: 'Узбекистан', city: 'Tashkent', address: '100000, Tashkent, Street 1',
      deliveryRegion: '', deliveryCost: 1281, total: 11271, deliveryMethod: 'ems',
      recipientCountryCode: 860, recipientCity: 'Tashkent', recipientStreet: 'Street 1', recipientIndex: '100000',
    },
    ...over,
  }
}

function makeMessaging() {
  return {
    sendToCustomer: vi.fn(async (..._a: any[]) => ({ ok: true })),
    sendToManagers: vi.fn(async (..._a: any[]) => {}),
    trackTemplate: vi.fn(async () => 'Трек: {{track-link}} ({{ord}})'),
  } satisfies EmsMessaging
}

/** последнее записанное в Sheets состояние */
function lastSavedState(): PochtaState {
  const calls = m.updatePochtaStateInSheet.mock.calls
  return JSON.parse(String(calls[calls.length - 1][1]))
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetEmsCaches()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-04T09:00:00Z'))
  m.checkRequiredPochtaEnv.mockReturnValue(true)
  m.findShipmentByOrderNum.mockResolvedValue(null)
  m.findBacklogOrderByOrderNum.mockResolvedValue(null)
  m.createBatch.mockResolvedValue('24')
  m.getShpiFromBatch.mockResolvedValue('LS000000001RU')
  m.getBatch.mockResolvedValue({ name: '24', status: 'CREATED', statusDate: null, listNumber: null, sendingDate: DATE })
  m.checkinBatch.mockResolvedValue({ f103Sent: true, errorCode: null })
  m.setBatchSendingDate.mockResolvedValue({ f103Sent: true, errorCode: null })
  m.findLeadByOrderNumber.mockResolvedValue({ id: 42, track: null, trackLink: null, barcode: null })
  m.getOrderFromSheet.mockResolvedValue(makeRow())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('computeEmsStage', () => {
  it('ведёт заказ по шагам: нет в Почте → ждёт даты → не оплачено → к отправке', () => {
    expect(computeEmsStage({}, null, TODAY)).toBe('no_pochta_order')
    expect(computeEmsStage({ orderId: 1 }, null, TODAY)).toBe('awaiting_date')
    expect(computeEmsStage({ orderId: 1, batch: '24' }, null, TODAY)).toBe('not_paid')
    expect(computeEmsStage({ orderId: 1, batch: '24', checkinAt: 'x', date: DATE }, null, TODAY)).toBe('ready')
  })

  it('дата прошла, а партия не принята — просрочено', () => {
    expect(computeEmsStage({ orderId: 1, batch: '24', checkinAt: 'x', date: '2026-11-03' }, null, TODAY)).toBe('overdue')
  })

  it('статус партии у Почты главнее нашего состояния', () => {
    const live = (batchStatus: string) => ({ batchName: '24', barcode: 'X', batchStatus, operationName: null, lastOperDate: null })
    const st: PochtaState = { orderId: 1, batch: '24', checkinAt: 'x', date: '2026-11-01' }
    expect(computeEmsStage(st, live('FROZEN'), TODAY)).toBe('accepted')
    expect(computeEmsStage(st, live('ACCEPTED'), TODAY)).toBe('accepted')
    expect(computeEmsStage(st, live('SENT'), TODAY)).toBe('in_transit')
    expect(computeEmsStage(st, live('ARCHIVED'), TODAY)).toBe('archived')
  })

  it('заказ старого пайплайна (партия есть только у Почты) — не оплачен', () => {
    const live = { batchName: '23', barcode: 'LS9RU', batchStatus: 'CREATED', operationName: null, lastOperDate: null }
    expect(computeEmsStage({}, live, TODAY)).toBe('not_paid')
  })
})

describe('parsePochtaState / даты', () => {
  it('пустое и битое состояние читается как пустое', () => {
    expect(parsePochtaState('')).toEqual({})
    expect(parsePochtaState('{oops')).toEqual({})
    expect(parsePochtaState('[1]')).toEqual({})
    expect(parsePochtaState('{"orderId":5}')).toEqual({ orderId: 5 })
  })

  it('isIsoDate отсекает несуществующие даты и чужой формат', () => {
    expect(isIsoDate('2026-11-05')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('05.11.2026')).toBe(false)
    expect(isIsoDate(undefined)).toBe(false)
  })

  it('«сегодня» — по Москве', () => {
    expect(moscowToday(Date.parse('2026-11-04T22:30:00Z'))).toBe('2026-11-05')
    expect(moscowToday(Date.parse('2026-11-04T20:59:00Z'))).toBe('2026-11-04')
  })
})

describe('shipEmsOrder', () => {
  it('первое назначение даты: партия с датой → checkin → документы → трек покупателю', async () => {
    const msg = makeMessaging()
    const res = await shipEmsOrder('ORD-1', DATE, msg)

    expect(res.ok).toBe(true)
    expect(m.createBatch).toHaveBeenCalledWith([777], DATE)
    expect(m.setBatchSendingDate).not.toHaveBeenCalled()
    expect(m.checkinBatch).toHaveBeenCalledTimes(1)
    expect(m.downloadF103).toHaveBeenCalledWith('24')
    expect(m.downloadF7p).toHaveBeenCalledWith(777)

    // трек виден в ЛК и уходит покупателю только сейчас
    expect(m.updatePochtaInfoInSheet).toHaveBeenCalledWith('ORD-1', 'LS000000001RU')
    expect(msg.sendToCustomer).toHaveBeenCalledWith('telegram', '123456', 'Трек: https://www.pochta.ru/tracking#LS000000001RU (ORD-1)')
    expect(m.updateAmoCrmLeadTrack).toHaveBeenCalledWith(42, 'LS000000001RU', 'https://www.pochta.ru/tracking#LS000000001RU')
    expect(m.setAmoCrmLeadBarcodeUrl).toHaveBeenCalledWith(42, expect.stringContaining('pochta-labels/forms-777-2026-11-05-'))
    expect(msg.sendToManagers).toHaveBeenCalledTimes(1)

    const st = lastSavedState()
    expect(st).toMatchObject({ orderId: 777, batch: '24', shpi: 'LS000000001RU', date: DATE, docsDate: DATE })
    expect(st.checkinAt).toBeTruthy()
    expect(st.releasedAt).toBeTruthy()
    expect(st.error).toBeUndefined()
  })

  // ссылки на S3 публичные, а в PDF адрес и телефон получателя — ключ нельзя угадать
  it('ключи документов в S3 со случайным хвостом', async () => {
    await shipEmsOrder('ORD-1', DATE, makeMessaging())
    const keys = m.uploadBufferToS3.mock.calls.map(c => String(c[0]))
    expect(keys).toHaveLength(2)
    for (const k of keys) expect(k).toMatch(/-2026-11-05-[0-9a-f]{12}\.pdf$/)
  })

  it('не хватает денег: ошибка менеджеру, трек покупателю не уходит, партия запомнена', async () => {
    m.checkinBatch.mockResolvedValue({ f103Sent: false, errorCode: 'NOT_ENOUGH_FUNDS' })
    const msg = makeMessaging()
    const res = await shipEmsOrder('ORD-1', DATE, msg)

    expect(res).toMatchObject({ ok: false, error: 'checkin_failed', code: 'NOT_ENOUGH_FUNDS', httpStatus: 200 })
    if (!res.ok) expect(res.message).toContain('Не хватает денег')
    expect(m.downloadF103).not.toHaveBeenCalled()
    expect(msg.sendToCustomer).not.toHaveBeenCalled()
    expect(m.updatePochtaInfoInSheet).not.toHaveBeenCalled()
    expect(lastSavedState()).toMatchObject({ batch: '24', date: DATE, error: 'NOT_ENOUGH_FUNDS' })
  })

  it('повтор после пополнения: вторую партию не создаёт, продолжает с checkin', async () => {
    m.getOrderFromSheet.mockResolvedValue(makeRow({
      pochtaState: JSON.stringify({ orderId: 777, batch: '24', shpi: 'LS000000001RU', date: DATE, error: 'NOT_ENOUGH_FUNDS' }),
    }))
    const msg = makeMessaging()
    const res = await shipEmsOrder('ORD-1', DATE, msg)

    expect(res.ok).toBe(true)
    expect(m.findShipmentByOrderNum).not.toHaveBeenCalled()
    expect(m.createBatch).not.toHaveBeenCalled()
    expect(m.checkinBatch).toHaveBeenCalledTimes(1)
    expect(msg.sendToCustomer).toHaveBeenCalledTimes(1)
    expect(lastSavedState().error).toBeUndefined()
  })

  it('checkin уже был (номер ф.103 есть), а запись потерялась — повторно не списывает', async () => {
    m.getOrderFromSheet.mockResolvedValue(makeRow({
      pochtaState: JSON.stringify({ orderId: 777, batch: '24', shpi: 'LS000000001RU', date: DATE }),
    }))
    m.getBatch.mockResolvedValue({ name: '24', status: 'CREATED', statusDate: null, listNumber: 3, sendingDate: DATE })
    const res = await shipEmsOrder('ORD-1', DATE, makeMessaging())

    expect(res.ok).toBe(true)
    expect(m.checkinBatch).not.toHaveBeenCalled()
    expect(lastSavedState().checkinAt).toBeTruthy()
  })

  it('перенос даты: новая дата у Почты, документы перекачаны, трек второй раз не шлётся', async () => {
    m.getOrderFromSheet.mockResolvedValue(makeRow({
      pochtaShpi: 'LS000000001RU',
      pochtaState: JSON.stringify({
        orderId: 777, batch: '24', shpi: 'LS000000001RU', date: DATE, checkinAt: 'x',
        f103: 'old-f103', forms: 'old-forms', docsDate: DATE, releasedAt: 'y',
      }),
    }))
    m.getBatch.mockResolvedValue({ name: '24', status: 'CREATED', statusDate: null, listNumber: 3, sendingDate: DATE })
    const msg = makeMessaging()
    const res = await shipEmsOrder('ORD-1', '2026-11-06', msg)

    expect(res.ok).toBe(true)
    expect(m.setBatchSendingDate).toHaveBeenCalledWith('24', '2026-11-06')
    expect(m.checkinBatch).not.toHaveBeenCalled()
    expect(m.downloadF103).toHaveBeenCalledTimes(1)
    expect(msg.sendToCustomer).not.toHaveBeenCalled()
    const st = lastSavedState()
    expect(st.date).toBe('2026-11-06')
    expect(st.docsDate).toBe('2026-11-06')
    expect(st.f103).not.toBe('old-f103')
  })

  it('принятую почтой посылку перенести нельзя', async () => {
    m.getOrderFromSheet.mockResolvedValue(makeRow({
      pochtaState: JSON.stringify({ orderId: 777, batch: '24', shpi: 'LS1', date: DATE, checkinAt: 'x', releasedAt: 'y' }),
    }))
    m.getBatch.mockResolvedValue({ name: '24', status: 'ACCEPTED', statusDate: null, listNumber: 3, sendingDate: DATE })
    const res = await shipEmsOrder('ORD-1', '2026-11-06', makeMessaging())
    expect(res).toMatchObject({ ok: false, error: 'already_accepted' })
    expect(m.setBatchSendingDate).not.toHaveBeenCalled()
  })

  it('заказ старого пайплайна: партию находит у Почты, трек повторно не шлёт', async () => {
    m.getOrderFromSheet.mockResolvedValue(makeRow({ pochtaState: '', pochtaShpi: 'LS9RU' }))
    m.findShipmentByOrderNum.mockResolvedValue({
      id: 999, orderNum: 'ORD-1', barcode: 'LS9RU', batchName: '23', batchStatus: 'CREATED', operationName: null, lastOperDate: null,
    })
    m.getBatch.mockResolvedValue({ name: '23', status: 'CREATED', statusDate: null, listNumber: null, sendingDate: '2026-08-08' })
    const msg = makeMessaging()
    const res = await shipEmsOrder('ORD-1', DATE, msg)

    expect(res.ok).toBe(true)
    expect(m.createPochtaOrder).not.toHaveBeenCalled()
    expect(m.createBatch).not.toHaveBeenCalled()
    expect(m.setBatchSendingDate).toHaveBeenCalledWith('23', DATE)
    expect(m.checkinBatch).toHaveBeenCalledWith('23')
    expect(msg.sendToCustomer).not.toHaveBeenCalled()
    expect(lastSavedState()).toMatchObject({ orderId: 999, batch: '23', shpi: 'LS9RU', releasedAt: expect.any(String) })
  })

  it('заказа нет в Почте (не создался при оплате) — создаёт его сам', async () => {
    m.getOrderFromSheet.mockResolvedValue(makeRow({ pochtaState: '' }))
    m.createPochtaOrder.mockResolvedValue({ id: 888 })
    const res = await shipEmsOrder('ORD-1', DATE, makeMessaging())
    expect(res.ok).toBe(true)
    expect(m.findBacklogOrderByOrderNum).toHaveBeenCalledWith('ORD-1')
    expect(m.createPochtaOrder).toHaveBeenCalledTimes(1)
    expect(m.createBatch).toHaveBeenCalledWith([888], DATE)
  })

  it('прошедшая дата отклоняется до любых запросов к Почте', async () => {
    const res = await shipEmsOrder('ORD-1', '2026-11-03', makeMessaging())
    expect(res).toMatchObject({ ok: false, error: 'past_date', httpStatus: 400 })
    expect(m.getOrderFromSheet).not.toHaveBeenCalled()
  })

  it('неоплаченный и не-EMS заказ не оформляются', async () => {
    m.getOrderFromSheet.mockResolvedValueOnce(makeRow({ sheetStatus: 'pending' }))
    expect(await shipEmsOrder('ORD-1', DATE, makeMessaging())).toMatchObject({ ok: false, error: 'not_paid' })
    m.getOrderFromSheet.mockResolvedValueOnce(makeRow({ orderData: { ...makeRow().orderData, deliveryMethod: 'cdek' } }))
    expect(await shipEmsOrder('ORD-1', DATE, makeMessaging())).toMatchObject({ ok: false, error: 'not_ems' })
    expect(m.createBatch).not.toHaveBeenCalled()
  })

  it('двойной клик не создаёт вторую партию', async () => {
    let release!: (v: unknown) => void
    m.getOrderFromSheet.mockImplementationOnce(() => new Promise(r => { release = r }))
    const msg = makeMessaging()
    const a = shipEmsOrder('ORD-1', DATE, msg)
    const b = shipEmsOrder('ORD-1', DATE, msg)
    expect(b).toBe(a)
    release(makeRow())
    await a
    expect(m.createBatch).toHaveBeenCalledTimes(1)
  })

  it('состояние не записалось после создания партии — честная ошибка, повтор найдёт партию у Почты', async () => {
    m.updatePochtaStateInSheet.mockRejectedValueOnce(new Error('quota'))
    const res = await shipEmsOrder('ORD-1', DATE, makeMessaging())
    expect(res).toMatchObject({ ok: false, error: 'state_save_failed' })
    expect(m.checkinBatch).not.toHaveBeenCalled()
  })

  it('сбой Почты на середине — ошибка с текстом, состояние сохранено', async () => {
    m.getBatch.mockRejectedValue(new Error('Pochta GET /1.0/batch/24 → HTTP 502'))
    const res = await shipEmsOrder('ORD-1', DATE, makeMessaging())
    expect(res).toMatchObject({ ok: false, error: 'pochta_failed', httpStatus: 502 })
    expect(lastSavedState()).toMatchObject({ batch: '24', error: expect.stringContaining('502') })
  })

  it('нет chat_id — оформление проходит, менеджер получает предупреждение', async () => {
    m.getOrderFromSheet.mockResolvedValue(makeRow({ customerChatId: null }))
    const msg = makeMessaging()
    const res = await shipEmsOrder('ORD-1', DATE, msg)
    expect(res.ok).toBe(true)
    expect(msg.sendToCustomer).not.toHaveBeenCalled()
    if (res.ok) expect(res.warnings.join(' ')).toContain('chat_id')
  })
})

describe('prepareEmsOrder (при оплате)', () => {
  const order = makeRow() as any

  it('только заказ в backlog — никаких партий и списаний', async () => {
    m.createPochtaOrder.mockResolvedValue({ id: 777 })
    await prepareEmsOrder(order)
    expect(m.createBatch).not.toHaveBeenCalled()
    expect(m.checkinBatch).not.toHaveBeenCalled()
    expect(m.updatePochtaStateInSheet).toHaveBeenCalledWith('ORD-1', JSON.stringify({ orderId: 777 }))
  })

  it('ответ потерялся, а заказ создался — находит его вместо дубля', async () => {
    m.createPochtaOrder.mockRejectedValueOnce(new Error('aborted'))
    m.findBacklogOrderByOrderNum.mockResolvedValueOnce(555)
    await prepareEmsOrder(order)
    expect(m.createPochtaOrder).toHaveBeenCalledTimes(1)
    expect(m.updatePochtaStateInSheet).toHaveBeenCalledWith('ORD-1', JSON.stringify({ orderId: 555 }))
  })

  it('без кода страны — алерт, в Почту не идёт', async () => {
    await prepareEmsOrder({ ...order, orderData: { ...order.orderData, recipientCountryCode: undefined } })
    expect(m.createPochtaOrder).not.toHaveBeenCalled()
    expect(m.sendAlert).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code: 'POCHTA_NO_COUNTRY' }))
  })
})

describe('listEmsOrders', () => {
  it('у Почты спрашивает только заказы с партией', async () => {
    const base = {
      createdAt: '', paidAt: '', platform: 'telegram', customerChatId: '', customerName: '', fullName: '', phone: '',
      username: '', country: '', city: '', address: '', deliveryCost: 0, total: 0, clientComment: '', adminNote: '', shpi: '', items: [],
    }
    m.listEmsOrdersFromSheet.mockResolvedValue([
      { ...base, orderId: 'ORD-A', pochtaState: JSON.stringify({ orderId: 1 }) },
      { ...base, orderId: 'ORD-B', pochtaState: JSON.stringify({ orderId: 2, batch: '24', checkinAt: 'x', date: DATE }) },
    ])
    m.findShipmentByOrderNum.mockResolvedValue({
      id: 2, orderNum: 'ORD-B', barcode: 'LS1', batchName: '24', batchStatus: 'ACCEPTED', operationName: 'Приём', lastOperDate: null,
    })
    const { orders, today } = await listEmsOrders()
    expect(today).toBe(TODAY)
    expect(m.findShipmentByOrderNum).toHaveBeenCalledTimes(1)
    expect(m.findShipmentByOrderNum).toHaveBeenCalledWith('ORD-B')
    expect(orders.map(o => [o.orderId, o.stage])).toEqual([['ORD-A', 'awaiting_date'], ['ORD-B', 'accepted']])
  })
})
