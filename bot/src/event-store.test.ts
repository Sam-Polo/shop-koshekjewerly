import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  __resetForTests,
  addRegistration,
  buildCsv,
  countByDate,
  countRegisteredSince,
  deleteDraft,
  getDraft,
  getRegistration,
  isFull,
  listRegistrations,
  listUnsynced,
  flushDrafts,
  loadEventDrafts,
  loadEventState,
  markSynced,
  oldestUnsyncedAgeMs,
  registrationCount,
  registrationsFile,
  setCapacity,
  setDraft,
  setMode,
  getMode,
  unsyncedCount,
  updateVisitDate,
  DRAFT_TTL_MS,
} from './event-store.js'

let tmpDir: string

function register(chatId: number, extra: Partial<{ name: string; username: string; visitDate: string; registeredAt: string }> = {}) {
  addRegistration({
    chatId,
    name: extra.name ?? `Гость ${chatId}`,
    username: extra.username ?? `user${chatId}`,
    visitDate: extra.visitDate ?? '2026-09-23',
    registeredAt: extra.registeredAt ?? new Date().toISOString(),
  })
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koshek-event-'))
  process.env.EVENT_DATA_DIR = tmpDir
  __resetForTests()
})

afterEach(() => {
  __resetForTests()
  delete process.env.EVENT_DATA_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('регистрации', () => {
  it('сохраняются на диск и переживают перезапуск', () => {
    register(111, { name: 'Аня Котова', visitDate: '2026-09-25' })
    register(222)

    __resetForTests()          // имитируем рестарт процесса
    expect(registrationCount()).toBe(0)

    loadEventState()

    expect(registrationCount()).toBe(2)
    expect(getRegistration(111)?.name).toBe('Аня Котова')
    expect(getRegistration(111)?.visitDate).toBe('2026-09-25')
  })

  it('повторная регистрация того же chat_id не плодит записей', () => {
    register(111, { visitDate: '2026-09-23' })
    register(111, { visitDate: '2026-09-24' })

    expect(registrationCount()).toBe(1)
    expect(getRegistration(111)?.visitDate).toBe('2026-09-24')
  })

  it('атомарная запись не оставляет .tmp', () => {
    register(111)
    const leftovers = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('битый файл откладывается в сторону, а не перезаписывается молча', () => {
    register(111)
    fs.writeFileSync(registrationsFile(), '{ это не json', 'utf8')

    __resetForTests()
    const { corruptedBackup } = loadEventState()

    // процесс жив (бот обслуживает заказы), список пуст, но данные не стёрты
    expect(corruptedBackup).toBeTruthy()
    expect(fs.existsSync(corruptedBackup!)).toBe(true)
    expect(fs.readFileSync(corruptedBackup!, 'utf8')).toContain('это не json')
    expect(registrationCount()).toBe(0)
  })

  it('новые регистрации после порчи файла пишутся в чистый журнал', () => {
    fs.writeFileSync(registrationsFile(), 'мусор', 'utf8')
    loadEventState()

    register(222)
    __resetForTests()
    loadEventState()

    expect(registrationCount()).toBe(1)
  })

  it('отсутствующий файл — нормальный старт с нуля', () => {
    expect(() => loadEventState()).not.toThrow()
    expect(registrationCount()).toBe(0)
  })
})

describe('лимит мест', () => {
  it('isFull срабатывает ровно на границе', () => {
    setCapacity(3)
    register(1); register(2)
    expect(isFull()).toBe(false)

    register(3)
    expect(isFull()).toBe(true)
  })

  it('лимит переживает перезапуск', () => {
    setCapacity(7)
    __resetForTests()
    loadEventState()
    expect(isFull()).toBe(false)
    setCapacity(1)
    register(1)
    __resetForTests()
    loadEventState()
    expect(isFull()).toBe(true)
  })
})

describe('режим приглашения', () => {
  it('переживает перезапуск', () => {
    setMode('off')
    __resetForTests()
    loadEventState()
    expect(getMode()).toBe('off')
  })
})

describe('выгрузка в таблицу', () => {
  it('новая запись считается невыгруженной', () => {
    register(111)
    expect(unsyncedCount()).toBe(1)
    expect(listUnsynced()).toHaveLength(1)
  })

  it('markSynced снимает флаг', () => {
    register(111)
    markSynced(listUnsynced())
    expect(unsyncedCount()).toBe(0)
  })

  it('смена даты снова делает запись невыгруженной', () => {
    register(111, { visitDate: '2026-09-23' })
    markSynced(listUnsynced())

    updateVisitDate(111, '2026-09-26')

    expect(unsyncedCount()).toBe(1)
    expect(getRegistration(111)?.visitDate).toBe('2026-09-26')
  })

  it('запись, изменённая во время выгрузки, не помечается выгруженной', () => {
    register(111, { visitDate: '2026-09-23' })
    const batch = listUnsynced()          // отправили в бэкенд...
    updateVisitDate(111, '2026-09-27')    // ...а человек поменял дату

    markSynced(batch)

    // иначе новая дата никогда не доехала бы до таблицы
    expect(unsyncedCount()).toBe(1)
  })

  it('markSynced сохраняет отметки на диск', () => {
    register(111)
    markSynced(listUnsynced())

    __resetForTests()
    loadEventState()

    expect(unsyncedCount()).toBe(0)
  })

  it('отставание считается по самой старой невыгруженной записи', () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    register(111, { registeredAt: hourAgo })
    register(222)

    expect(oldestUnsyncedAgeMs()).toBeGreaterThanOrEqual(59 * 60 * 1000)

    markSynced(listUnsynced())
    expect(oldestUnsyncedAgeMs()).toBe(0)
  })
})

describe('черновики формы', () => {
  it('переживают перезапуск', () => {
    setDraft({ chatId: 111, step: 'date', kind: 'new', name: 'Аня Котова' })
    flushDrafts()              // в бою это делает debounce-таймер или остановка процесса

    __resetForTests()
    loadEventDrafts()

    expect(getDraft(111)?.name).toBe('Аня Котова')
    expect(getDraft(111)?.step).toBe('date')
  })

  it('протухший черновик не возвращается', () => {
    setDraft({ chatId: 111, step: 'name', kind: 'new' })
    const draft = getDraft(111)!
    draft.updatedAt = Date.now() - DRAFT_TTL_MS - 1000

    expect(getDraft(111)).toBeUndefined()
  })

  it('deleteDraft убирает черновик', () => {
    setDraft({ chatId: 111, step: 'name', kind: 'new' })
    deleteDraft(111)
    expect(getDraft(111)).toBeUndefined()
  })
})

describe('сводки для менеджера', () => {
  it('считает по датам', () => {
    register(1, { visitDate: '2026-09-23' })
    register(2, { visitDate: '2026-09-23' })
    register(3, { visitDate: '2026-09-27' })

    const byDate = countByDate()
    expect(byDate.get('2026-09-23')).toBe(2)
    expect(byDate.get('2026-09-27')).toBe(1)
  })

  it('считает свежие регистрации', () => {
    register(1, { registeredAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() })
    register(2)

    expect(countRegisteredSince(Date.now() - 60 * 60 * 1000)).toBe(1)
  })

  it('список отсортирован по времени регистрации', () => {
    register(2, { registeredAt: '2026-09-02T10:00:00.000Z' })
    register(1, { registeredAt: '2026-09-01T10:00:00.000Z' })

    expect(listRegistrations().map(r => r.chatId)).toEqual([1, 2])
  })
})

describe('CSV', () => {
  it('начинается с BOM и заголовка', () => {
    register(111)
    const csv = buildCsv()
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv.split('\r\n')[0]).toBe('﻿name;username;chat_id;visit_date;registered_at;synced')
  })

  it('ник отдаётся с собакой, chat_id как есть', () => {
    register(111, { name: 'Аня Котова', username: 'anya', visitDate: '2026-09-24' })
    const row = buildCsv().split('\r\n')[1]
    expect(row).toBe('Аня Котова;@anya;111;2026-09-24;' + getRegistration(111)!.registeredAt + ';нет')
  })

  it('пустой ник не превращается в одинокую собаку', () => {
    register(111, { username: '' })
    expect(buildCsv().split('\r\n')[1].split(';')[1]).toBe('')
  })

  it('точка с запятой в имени не разъезжается по колонкам', () => {
    register(111, { name: 'Аня; Котова' })
    expect(buildCsv()).toContain('"Аня; Котова"')
  })

  it('имя, похожее на формулу, обезвреживается', () => {
    register(111, { name: '=1+1' })
    // без апострофа Excel исполнил бы это как формулу при открытии файла
    expect(buildCsv()).toContain("'=1+1")
  })
})
