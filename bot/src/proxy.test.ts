import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// файл сбоев уводим во временный, чтобы тесты не писали в рабочую директорию бота
const TMP_LOG = path.join(os.tmpdir(), `tg-failed-${process.pid}.json`)
process.env.TG_FAILED_LOG_PATH = TMP_LOG
process.env.TG_RETRY_DELAYS_MS = '1,1,1'   // не ждём настоящие 1/3/9 с

const { tgFetch, setTgFailureReporter } = await import('./proxy.js')

const reporter = vi.fn()
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const URL_SEND = 'https://api.telegram.org/bot123456:SECRET-token/sendMessage'
const INIT = {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: 777, text: 'заказ отправлен' }),
}

function resp(status: number) {
  return { ok: status >= 200 && status < 300, status }
}

beforeEach(() => {
  reporter.mockClear()
  fetchMock.mockReset()
  setTgFailureReporter(reporter)
  if (fs.existsSync(TMP_LOG)) fs.unlinkSync(TMP_LOG)
})

afterAll(() => {
  setTgFailureReporter(null)
  if (fs.existsSync(TMP_LOG)) fs.unlinkSync(TMP_LOG)
})

describe('tgFetch', () => {
  it('успех не тревожит никого', async () => {
    fetchMock.mockResolvedValueOnce(resp(200))
    const r = await tgFetch(URL_SEND, INIT)
    expect(r.status).toBe(200)
    expect(reporter).not.toHaveBeenCalled()
  })

  it('4xx кроме 429 не ретраит — это наша ошибка, а не сеть', async () => {
    fetchMock.mockResolvedValueOnce(resp(400))
    const r = await tgFetch(URL_SEND, INIT)
    expect(r.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reporter).not.toHaveBeenCalled()
  })

  it('сообщает о потере, когда попытки исчерпаны, и говорит кому и что не ушло', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'))
    await expect(tgFetch(URL_SEND, INIT)).rejects.toThrow('fetch failed')

    expect(fetchMock).toHaveBeenCalledTimes(4) // первая + 3 повтора
    expect(reporter).toHaveBeenCalledTimes(1)
    const f = reporter.mock.calls[0][0]
    expect(f.method).toBe('sendMessage')
    expect(f.chatId).toBe('777')
    expect(f.preview).toBe('заказ отправлен')
    // токен бота в отчёт не утекает
    expect(f.url).not.toContain('SECRET-token')
  })

  it('silent молчит — иначе неудачный алерт породил бы алерт о себе', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'))
    await expect(tgFetch(URL_SEND, INIT, { silent: true })).rejects.toThrow()
    expect(reporter).not.toHaveBeenCalled()
  })

  it('пишет потерянное в файл — чтобы можно было переслать руками', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'))
    await expect(tgFetch(URL_SEND, INIT)).rejects.toThrow()
    const saved = JSON.parse(fs.readFileSync(TMP_LOG, 'utf8'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ chatId: '777', preview: 'заказ отправлен' })
  })

  it('падение репортера не ломает отправку', async () => {
    setTgFailureReporter(() => { throw new Error('репортер сломался') })
    fetchMock.mockRejectedValue(new Error('fetch failed'))
    await expect(tgFetch(URL_SEND, INIT)).rejects.toThrow('fetch failed')
  })
})
