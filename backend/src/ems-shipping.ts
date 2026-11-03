import crypto from 'node:crypto'
import pino from 'pino'
import type { Order, Platform } from './orders.js'
import { sendAlert } from './alerts.js'
import {
  checkRequiredPochtaEnv, createPochtaOrder, createBatch, getShpiFromBatch, getBatch,
  setBatchSendingDate, checkinBatch, downloadF103, downloadF7p,
  findShipmentByOrderNum, findBacklogOrderByOrderNum,
} from './pochta.js'
import {
  getOrderFromSheet, updatePochtaStateInSheet, updatePochtaInfoInSheet,
  updateOrderAdminNoteInSheet, listEmsOrdersFromSheet, type EmsSheetOrder, type SheetOrder,
} from './orders-sheet.js'
import { uploadBufferToS3 } from './s3.js'
import { findLeadByOrderNumber, updateAmoCrmLeadTrack, setAmoCrmLeadBarcodeUrl } from './amocrm.js'

// ── Оформление EMS (Почта России) в два шага ─────────────────────────────────────
//
// 1. При оплате (prepareEmsOrder) — только заказ в backlog Почты. Это бесплатно, и
//    Почта сразу проверяет адрес. Трека у покупателя ещё нет.
// 2. Менеджер назначает дату отправки в админке, раздел EMS (shipEmsOrder):
//    партия с этой датой → ШПИ → checkin (списывает тариф с онлайн-баланса, шлёт
//    ф.103 в отделение) → ф.103 и бланки в S3 → трек покупателю, в ЛК и в amoCRM.
//
// Почему не всё сразу при оплате: дата сдачи печатается на документах, и отделение ждёт
// партию именно в этот день. Партия с датой оплаты «просрочивается», если посылку несут
// позже, а деньги списывались бы за заказы, которые ещё неделю собирают.
//
// Каждый шаг можно безопасно повторить: состояние лежит в колонке pochta_state, а то,
// что знает сама Почта (партия, ШПИ, пройден ли checkin, дата сдачи), перечитывается
// у неё. Сбой на середине → повторное нажатие продолжает с того же места.
// Подробно: docs/integrations/pochta-ems.md.

const logger = pino()

/**
 * С какого момента оплаченные EMS-заказы попадают в раздел EMS. Заказы июля–августа
 * шли старым пайплайном и разбирались вручную — показывать их «ждущими даты» нельзя.
 */
export const EMS_SECTION_SINCE = '2026-11-03T00:00:00+03:00'

/** Состояние оформления у Почты — JSON в колонке pochta_state листа orders. */
export interface PochtaState {
  /** id заказа в backlog Почты (он же id отправления после переноса в партию) */
  orderId?: number
  /** номер партии (одна партия = один заказ) */
  batch?: string
  /** ШПИ; покупателю уходит только на шаге выпуска трека */
  shpi?: string
  /** назначенная дата сдачи, yyyy-MM-dd */
  date?: string
  /** когда прошёл checkin: тариф списан, электронная ф.103 ушла в отделение */
  checkinAt?: string
  /** ф.103 (список партии для отделения) в S3 */
  f103?: string
  /** бланки (CN22 + адресный ярлык) в S3 */
  forms?: string
  /** на какую дату скачаны документы — после переноса даты их надо перекачать */
  docsDate?: string
  /** когда трек выпущен покупателю (сообщение, ЛК, amoCRM) */
  releasedAt?: string
  /** последняя ошибка оформления — показывается в админке */
  error?: string
  errorAt?: string
}

export function parsePochtaState(raw: string | null | undefined): PochtaState {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v as PochtaState : {}
  } catch {
    // битая ячейка не страшна: партию и заказ шаги найдут у самой Почты по номеру заказа
    logger.warn({ raw: raw.slice(0, 100) }, 'pochta_state: битый JSON — читаем как пустое состояние')
    return {}
  }
}

/** Сегодняшняя дата по Москве, yyyy-MM-dd: отделение и менеджеры живут по МСК. */
export function moscowToday(now = Date.now()): string {
  return new Date(now + 3 * 3600_000).toISOString().slice(0, 10)
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

// ── Статус для раздела EMS ───────────────────────────────────────────────────────

export type EmsStage =
  | 'no_pochta_order' // заказа нет в Почте (не создался при оплате)
  | 'awaiting_date'   // ждёт даты отправки
  | 'not_paid'        // партия есть, checkin не прошёл (обычно не хватает денег на балансе)
  | 'ready'           // оплачено, документы готовы, ждём похода в отделение
  | 'overdue'         // дата сдачи прошла, а посылку не сдали
  | 'accepted'        // отделение приняло партию
  | 'in_transit'      // по отправлению есть данные трекинга
  | 'archived'

/** То, что Почта знает об отправлении прямо сейчас (поиск по номеру заказа). */
export interface EmsLive {
  batchName: string | null
  barcode: string | null
  batchStatus: string | null
  operationName: string | null
  lastOperDate: string | null
}

/**
 * Статус партии у Почты главнее нашего состояния: принятую посылку показываем
 * принятой, даже если наша запись отстала. Справочник статусов —
 * enums-base-batch-status: CREATED → FROZEN (идёт приём) → ACCEPTED → SENT → ARCHIVED.
 */
export function computeEmsStage(state: PochtaState, live: EmsLive | null, today: string): EmsStage {
  const status = live?.batchStatus ?? null
  if (status === 'ARCHIVED') return 'archived'
  if (status === 'SENT') return 'in_transit'
  if (status === 'ACCEPTED' || status === 'FROZEN') return 'accepted'
  const batch = state.batch ?? live?.batchName ?? null
  if (!batch) return state.orderId ? 'awaiting_date' : 'no_pochta_order'
  if (!state.checkinAt) return 'not_paid'
  if (state.date && state.date < today) return 'overdue'
  return 'ready'
}

// ── Связь с остальной системой ─────────────────────────────────────────────────

/** Транспорт сообщений живёт в server.ts — передаётся снаружи, чтобы не было циклического импорта. */
export interface EmsMessaging {
  sendToCustomer(platform: Platform, chatId: string, html: string): Promise<{ ok: boolean; errorDescription?: string }>
  sendToManagers(platform: Platform, html: string): Promise<void>
  /** шаблон трек-сообщения покупателю (настройки админки или дефолт) */
  trackTemplate(): Promise<string>
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ── Шаг 1: при оплате ───────────────────────────────────────────────────────────

const CREATE_RETRY_DELAYS_MS = [2_000, 4_000]

/**
 * Создаёт заказ в backlog Почты сразу после оплаты. Ни партии, ни ШПИ, ни списаний.
 * Никогда не бросает: сбои уходят алертом, а в админке заказ будет «нет в Почте» —
 * кнопка назначения даты создаст его заново.
 */
export async function prepareEmsOrder(order: Order): Promise<void> {
  const orderId = order.orderId
  try {
    if (!checkRequiredPochtaEnv()) return
    if (!order.orderData.recipientCountryCode) {
      sendAlert(
        `Pochta: у EMS-заказа ${orderId} нет кода страны получателя — в Почте он не создан`,
        { tag: 'pochta', level: 'high', hint: 'оформите отправление в ЛК Почты вручную', code: 'POCHTA_NO_COUNTRY' },
      ).catch(() => {})
      return
    }

    let pochtaOrderId: number | null = null
    let lastErr: any = null
    for (let attempt = 1; attempt <= 3 && pochtaOrderId === null; attempt++) {
      try {
        pochtaOrderId = (await createPochtaOrder(order)).id
      } catch (e: any) {
        lastErr = e
        // ответ мог потеряться по таймауту, а заказ — создаться: перед повтором ищем его,
        // иначе в backlog окажется дубль с тем же номером
        pochtaOrderId = await findBacklogOrderByOrderNum(orderId).catch(() => null)
        if (pochtaOrderId === null && attempt < 3) await sleep(CREATE_RETRY_DELAYS_MS[attempt - 1])
      }
    }

    if (pochtaOrderId === null) {
      const message = String(lastErr?.message ?? 'неизвестная ошибка')
      sendAlert(
        `Pochta: EMS-заказ ${orderId} не создан в Почте после 3 попыток: ${message}`,
        {
          tag: 'pochta', level: 'high', code: 'POCHTA_ORDER_CREATE_FAILED',
          hint: 'админка → EMS: «Назначить дату» попробует создать заказ заново; если Почта отклоняет адрес — оформить в ЛК вручную',
        },
      ).catch(() => {})
      await updatePochtaStateInSheet(orderId, JSON.stringify({ error: message.slice(0, 300), errorAt: new Date().toISOString() }))
        .catch(() => {})
      return
    }

    await updatePochtaStateInSheet(orderId, JSON.stringify({ orderId: pochtaOrderId })).catch((e: any) => {
      // не критично: при назначении даты заказ найдётся поиском в backlog по номеру
      logger.warn({ orderId, pochtaOrderId, error: e?.message }, 'prepareEmsOrder: id заказа Почты не записан в Sheets')
    })
    logger.info({ orderId, pochtaOrderId }, 'EMS: заказ создан в backlog Почты, ждёт даты отправки')
  } catch (e: any) {
    sendAlert(
      `Pochta: необработанная ошибка при создании EMS-заказа ${orderId} в Почте: ${e?.message}`,
      { tag: 'pochta', level: 'high', code: 'POCHTA_PREPARE_UNHANDLED' },
    ).catch(() => {})
  }
}

// ── Шаг 2: назначение даты отправки ───────────────────────────────────────────────

export type ShipError =
  | 'bad_date' | 'past_date' | 'pochta_env' | 'order_not_found' | 'not_ems' | 'not_paid'
  | 'no_recipient' | 'already_accepted' | 'date_rejected' | 'checkin_failed'
  | 'pochta_failed' | 'state_save_failed'

export type ShipResult =
  | { ok: true; state: PochtaState; warnings: string[] }
  | { ok: false; error: ShipError; message: string; code?: string | null; state?: PochtaState; httpStatus: number }

/** Понятный менеджеру текст отказа checkin. */
export function checkinErrorMessage(code: string | null): string {
  switch (code) {
    case 'NOT_ENOUGH_FUNDS':
      return 'Не хватает денег на балансе Почты. Пополните онлайн-баланс в ЛК otpravka.pochta.ru и нажмите ещё раз.'
    case 'PAST_DUE_DATE':
      return 'Дата сдачи уже прошла — выберите сегодня или позже.'
    case 'OFFLINE_BALANCE_FORBIDDEN':
      return 'Почта пытается списать оплату не с онлайн-баланса — это ошибка в коде, напишите разработчику.'
    default:
      return `Почта не подготовила партию к отправке: ${code ?? 'причина не указана'}.`
  }
}

const running = new Map<string, Promise<ShipResult>>()

/**
 * Назначает (или переносит) дату отправки EMS-заказа и доводит оформление до конца.
 * Повторный вызов, пока идёт предыдущий по тому же заказу, ждёт его же результата —
 * двойной клик не создаст вторую партию. Никогда не бросает.
 */
export function shipEmsOrder(orderId: string, sendingDate: string, messaging: EmsMessaging): Promise<ShipResult> {
  const inFlight = running.get(orderId)
  if (inFlight) return inFlight
  const job = runShip(orderId, sendingDate, messaging).finally(() => {
    running.delete(orderId)
    liveCache.delete(orderId)
  })
  running.set(orderId, job)
  return job
}

/** Идёт ли сейчас оформление заказа (для ответа админке «ещё в процессе»). */
export function isShipRunning(orderId: string): boolean {
  return running.has(orderId)
}

class StateSaveError extends Error {}

async function runShip(orderId: string, sendingDate: string, messaging: EmsMessaging): Promise<ShipResult> {
  const fail = (error: ShipError, httpStatus: number, message: string, extra: Partial<Extract<ShipResult, { ok: false }>> = {}): ShipResult =>
    ({ ok: false, error, message, httpStatus, ...extra })

  if (!isIsoDate(sendingDate)) return fail('bad_date', 400, 'Дата должна быть в формате ГГГГ-ММ-ДД')
  if (sendingDate < moscowToday()) return fail('past_date', 400, `${fmtDay(sendingDate)} уже прошло — выберите сегодня или позже`)
  if (!checkRequiredPochtaEnv()) return fail('pochta_env', 500, 'На сервере не заданы ключи Почты (алерт уже в канале ошибок)')

  const row = await getOrderFromSheet(orderId)
  if (!row) return fail('order_not_found', 404, 'Заказ не найден в таблице')
  if (row.orderData.deliveryMethod !== 'ems') return fail('not_ems', 400, 'Это не EMS-заказ')
  if (row.sheetStatus !== 'paid') return fail('not_paid', 400, 'Заказ не оплачен')

  const state = parsePochtaState(row.pochtaState)
  const warnings: string[] = []
  const now = () => new Date().toISOString()
  const save = async () => {
    try {
      await updatePochtaStateInSheet(orderId, JSON.stringify(state))
    } catch (e: any) {
      throw new StateSaveError(e?.message ?? 'Sheets недоступен')
    }
  }

  try {
    // 1. Заказ в Почте. Он мог уже уехать в партию: старый пайплайн оформлял партию
    //    прямо при оплате, плюс возможен сбой записи состояния — поэтому сперва поиск.
    if (!state.batch) {
      const found = await findShipmentByOrderNum(orderId)
      if (found?.batchName) {
        state.orderId = found.id
        state.batch = found.batchName
        if (found.barcode) state.shpi = found.barcode
      }
    }
    if (!state.orderId) {
      state.orderId = (await findBacklogOrderByOrderNum(orderId)) ?? undefined
      if (!state.orderId) {
        if (!row.orderData.recipientCountryCode) {
          return fail('no_recipient', 422, 'В заказе нет адреса получателя для Почты — оформите отправление в ЛК Почты вручную')
        }
        state.orderId = (await createPochtaOrder(row)).id
      }
      await save()
    }

    // 2. Партия сразу с нужной датой: Почта присваивает ШПИ.
    if (!state.batch) {
      try {
        state.batch = await createBatch([state.orderId], sendingDate)
      } catch (e: any) {
        if (e?.code === 'PAST_DUE_DATE') return fail('date_rejected', 400, checkinErrorMessage('PAST_DUE_DATE'), { code: e.code, state })
        throw e
      }
      state.date = sendingDate
      await save()
    }
    if (!state.shpi) {
      for (let i = 0; i < 5 && !state.shpi; i++) {
        state.shpi = (await getShpiFromBatch(state.batch).catch(() => null)) ?? undefined
        if (!state.shpi && i < 4) await sleep(3_000)
      }
    }

    // 3. Дата и checkin. Что прошло, а что нет, спрашиваем у самой Почты.
    const info = await getBatch(state.batch)
    if (info.status && info.status !== 'CREATED') {
      // FROZEN/ACCEPTED/SENT: отделение уже принимает или приняло партию — дату не трогаем
      if (info.sendingDate !== sendingDate) {
        return fail('already_accepted', 409, 'Посылку уже приняли на почте — дату отправки менять нельзя', { state })
      }
    } else if (info.sendingDate !== sendingDate) {
      const r = await setBatchSendingDate(state.batch, sendingDate)
      if (r.errorCode && !r.f103Sent) {
        state.error = r.errorCode
        state.errorAt = now()
        await save()
        return fail('date_rejected', 200, `Почта не приняла дату: ${checkinErrorMessage(r.errorCode)}`, { code: r.errorCode, state })
      }
    }
    state.date = sendingDate

    if (info.listNumber == null) {
      const ci = await checkinBatch(state.batch)
      if (!ci.f103Sent) {
        state.error = ci.errorCode ?? 'CHECKIN_FAILED'
        state.errorAt = now()
        await save()
        sendAlert(
          `Pochta: партия ${state.batch} (заказ ${orderId}) не прошла checkin: ${ci.errorCode ?? 'причина не указана'}. Менеджер видит это в админке.`,
          {
            tag: 'pochta', level: 'moderate', code: 'POCHTA_CHECKIN_FAILED',
            hint: ci.errorCode === 'NOT_ENOUGH_FUNDS'
              ? 'пополнить онлайн-баланс в ЛК otpravka.pochta.ru и нажать «Назначить дату» ещё раз'
              : 'см. docs/integrations/pochta-ems.md',
          },
        ).catch(() => {})
        return fail('checkin_failed', 200, checkinErrorMessage(ci.errorCode), { code: ci.errorCode, state })
      }
    }
    // если listNumber уже был — checkin прошёл раньше, а запись о нём потерялась
    if (!state.checkinAt) state.checkinAt = now()
    delete state.error
    delete state.errorAt
    await save()

    // 4. Документы. Печатаются с датой — после переноса скачиваем заново. В ключе S3
    //    случайный хвост: ссылки публичные, а в PDF адрес и телефон получателя.
    if (state.docsDate !== state.date || !state.f103 || !state.forms) {
      const tag = `${state.date}-${crypto.randomBytes(6).toString('hex')}`
      try {
        const pdf = await downloadF103(state.batch)
        state.f103 = await uploadBufferToS3(`pochta-labels/f103-${state.batch}-${tag}.pdf`, pdf, 'application/pdf')
      } catch (e: any) {
        delete state.f103
        warnings.push('ф.103 не скачалась — нажмите кнопку ещё раз через минуту или распечатайте ф.103 в ЛК Почты')
        sendAlert(
          `Pochta: checkin партии ${state.batch} прошёл, но ф.103 не скачалась (заказ ${orderId}): ${e?.message}`,
          { tag: 'pochta', level: 'high', hint: 'повторить назначение даты в админке или распечатать в ЛК', code: 'POCHTA_F103_FAILED' },
        ).catch(() => {})
      }
      try {
        const pdf = await downloadF7p(state.orderId)
        state.forms = await uploadBufferToS3(`pochta-labels/forms-${state.orderId}-${tag}.pdf`, pdf, 'application/pdf')
      } catch (e: any) {
        delete state.forms
        warnings.push('бланки не скачались — нажмите кнопку ещё раз через минуту или распечатайте бланки в ЛК Почты')
        sendAlert(
          `Pochta: бланки заказа ${orderId} (id ${state.orderId}) не скачались после checkin: ${e?.message}`,
          { tag: 'pochta', level: 'high', hint: 'повторить назначение даты в админке или распечатать в ЛК', code: 'POCHTA_FORMS_FAILED' },
        ).catch(() => {})
      }
      if (state.f103 && state.forms) state.docsDate = state.date
      await save()
    }

    // 5. Трек покупателю — один раз, при первом назначении даты.
    if (!state.releasedAt) {
      if (row.pochtaShpi) {
        // старый пайплайн уже отправил трек при оплате — повторно не шлём
        state.releasedAt = new Date(row.updatedAt).toISOString()
      } else if (!state.shpi) {
        warnings.push('Почта ещё не присвоила ШПИ — трек покупателю не отправлен. Нажмите кнопку ещё раз через минуту.')
      } else {
        await releaseTrack(row, state, messaging, warnings)
        state.releasedAt = now()
      }
      await save()
    }

    logger.info({ orderId, batch: state.batch, date: state.date, warnings: warnings.length }, 'EMS: дата отправки назначена')
    return { ok: true, state, warnings }
  } catch (e: any) {
    if (e instanceof StateSaveError) {
      sendAlert(
        `EMS: шаг оформления заказа ${orderId} выполнен у Почты, но состояние не записано в Sheets: ${e.message}`,
        { tag: 'pochta', level: 'moderate', hint: 'повторное нажатие найдёт партию у Почты по номеру заказа', code: 'POCHTA_STATE_SAVE_FAILED' },
      ).catch(() => {})
      return fail('state_save_failed', 500, 'Не удалось сохранить результат в таблицу — нажмите ещё раз, оформление продолжится с того же места', { state })
    }
    const message = String(e?.message ?? e)
    sendAlert(
      `Pochta: назначение даты отправки заказа ${orderId} прервалось: ${message}`,
      { tag: 'pochta', level: 'moderate', hint: 'повторное нажатие продолжит с того же шага', code: 'POCHTA_SHIP_FAILED' },
    ).catch(() => {})
    state.error = message.slice(0, 300)
    state.errorAt = now()
    await updatePochtaStateInSheet(orderId, JSON.stringify(state)).catch(() => {})
    return fail('pochta_failed', 502, `Почта не ответила или вернула ошибку: ${message.slice(0, 200)}. Нажмите ещё раз — оформление продолжится с того же места.`, { state })
  }
}

/** Выпуск трека: ЛК мини-аппа, amoCRM, покупатель, канал заказов. Сбои — в warnings и алерты. */
async function releaseTrack(row: SheetOrder, state: PochtaState, messaging: EmsMessaging, warnings: string[]): Promise<void> {
  const orderId = row.orderId
  const shpi = state.shpi!
  const trackingUrl = `https://www.pochta.ru/tracking#${shpi}`
  const platform: Platform = row.platform ?? 'telegram'

  // ЛК мини-аппа и отбивка «отправлен» берут трек из pochta_shpi
  await updatePochtaInfoInSheet(orderId, shpi)

  try {
    const lead = await findLeadByOrderNumber(orderId)
    if (lead) {
      await updateAmoCrmLeadTrack(lead.id, shpi, trackingUrl)
      // бланки — то, что клеится на посылку, им место в поле штрихкода (как у СДЭКа)
      if (state.forms) await setAmoCrmLeadBarcodeUrl(lead.id, state.forms)
    } else {
      warnings.push('сделка в amoCRM не найдена — трек туда не записан')
    }
  } catch (e: any) {
    warnings.push('трек не записан в amoCRM (алерт в канале ошибок)')
    sendAlert(
      `amoCRM: не удалось записать ШПИ ${shpi} в сделку заказа ${orderId}: ${e?.message}`,
      { tag: 'amocrm', level: 'low', code: 'AMOCRM_TRACK_UPDATE_FAILED' },
    ).catch(() => {})
  }

  if (row.customerChatId) {
    const template = await messaging.trackTemplate()
    const text = template
      .replace(/\{\{track\}\}/g, shpi)
      .replace(/\{\{track-link\}\}/g, trackingUrl)
      .replace(/\{\{ord\}\}/g, orderId)
    const sent = await messaging.sendToCustomer(platform, row.customerChatId, text)
    if (sent.ok) {
      const line = `track: ${trackingUrl}`
      if (!row.adminNote.includes(line)) {
        updateOrderAdminNoteInSheet(orderId, row.adminNote ? `${row.adminNote}\n${line}` : line).catch(() => {})
      }
    } else {
      warnings.push(`трек не доставлен покупателю: ${sent.errorDescription ?? 'неизвестная ошибка'}`)
      sendAlert(
        `EMS: трек ${shpi} по заказу ${orderId} не доставлен покупателю: ${sent.errorDescription ?? 'неизвестно'}`,
        { tag: 'pochta', level: 'moderate', code: 'POCHTA_TRACK_SEND_FAILED' },
      ).catch(() => {})
    }
  } else {
    warnings.push('у заказа нет chat_id — трек покупателю не отправлен, передайте его вручную')
  }

  const office = process.env.POCHTA_INDEX_FROM || '121596'
  const docs = [
    state.f103 ? `📄 Ф.103: ${state.f103}` : '⚠️ ф.103 не скачалась — возьмите в админке → EMS позже',
    state.forms ? `🏷 Бланки: ${state.forms}` : '⚠️ бланки не скачались — возьмите в админке → EMS позже',
  ].join('\n')
  await messaging.sendToManagers(
    platform,
    `📦 <b>EMS: назначена отправка</b>\nЗаказ <code>${orderId}</code> — сдать в отделение ${office} <b>${fmtDay(state.date!)}</b>\n` +
    `ШПИ: <code>${shpi}</code>\n${trackingUrl}\n\n${docs}`,
  ).catch(() => {})
}

// ── Список для раздела EMS ───────────────────────────────────────────────────────

export type EmsListItem = Omit<EmsSheetOrder, 'pochtaState'> & {
  state: PochtaState
  live: EmsLive | null
  liveError?: string
  stage: EmsStage
  /** идёт ли прямо сейчас оформление (кнопку нажали, Почта ещё отвечает) */
  shipping: boolean
}

const LIVE_TTL_MS = 60_000
const liveCache = new Map<string, { at: number; live: EmsLive | null }>()

async function getLive(orderId: string): Promise<EmsLive | null> {
  const cached = liveCache.get(orderId)
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.live
  const found = await findShipmentByOrderNum(orderId)
  const live: EmsLive | null = found
    ? {
        batchName: found.batchName,
        barcode: found.barcode,
        batchStatus: found.batchStatus,
        operationName: found.operationName,
        lastOperDate: found.lastOperDate,
      }
    : null
  liveCache.set(orderId, { at: Date.now(), live })
  return live
}

/** EMS-заказы с живым статусом у Почты. Запросы к Почте — не больше 4 одновременно. */
export async function listEmsOrders(): Promise<{ orders: EmsListItem[]; today: string }> {
  const rows = await listEmsOrdersFromSheet(EMS_SECTION_SINCE)
  const today = moscowToday()
  const result: EmsListItem[] = new Array(rows.length)
  let next = 0
  const worker = async () => {
    while (next < rows.length) {
      const i = next++
      const { pochtaState, ...row } = rows[i]
      const state = parsePochtaState(pochtaState)
      let live: EmsLive | null = null
      let liveError: string | undefined
      // у заказа без партии Почте рассказать нечего — не спрашиваем
      if (state.batch || row.shpi) {
        try {
          live = await getLive(row.orderId)
        } catch (e: any) {
          liveError = String(e?.message ?? e).slice(0, 200)
        }
      }
      result[i] = {
        ...row,
        state,
        live,
        liveError,
        stage: computeEmsStage(state, live, today),
        shipping: running.has(row.orderId),
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker))
  return { orders: result, today }
}

/** для тестов */
export function _resetEmsCaches(): void {
  liveCache.clear()
  running.clear()
}
