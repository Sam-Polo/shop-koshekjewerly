/**
 * One-off script: for Tilda leads — fill missing track link and/or CDEK barcode.
 *
 * Tilda leads were imported with a CDEK track number but without:
 *   - Track link (URL to CDEK LK manager page)
 *   - Barcode PDF (uploaded to Yandex S3, URL saved to amoCRM url-field)
 *
 * The script:
 *   1. Fetches all leads named "Тильда импорт" from amoCRM (paginated).
 *   2. Reports the count, then filters to those with a track but missing link/barcode.
 *   3. For each: builds the track link; downloads the barcode from CDEK via UUID lookup.
 *   4. Patches only the missing fields (skips already-filled ones).
 *
 * Note: barcode generation involves CDEK polling (~4–20 s per lead). With many leads
 * this will take several minutes — that is expected.
 *
 * Usage:
 *   npx tsx src/scripts/fill-tilda-barcodes.ts
 */

import 'dotenv/config'
import { getCdekUuidByTrack, downloadCdekBarcode } from '../cdek.js'
import { uploadBufferToS3 } from '../s3.js'

const AMO_BASE = `https://${process.env.AMOCRM_SUBDOMAIN}.amocrm.ru`
const AMO_TOKEN = process.env.AMOCRM_ACCESS_TOKEN!
const TILDA_LEAD_NAME = 'Тильда импорт'
const DELAY_MS = 400

const F = {
  cdekTrack: Number(process.env.AMOCRM_FIELD_CDEK_TRACK_ID),
  trackLink: Number(process.env.AMOCRM_FIELD_TRACK_LINK_ID),
  barcode:   Number(process.env.AMOCRM_FIELD_BARCODE_ID),
}

function getFieldValue(lead: any, fieldId: number): string | null {
  const f = (lead.custom_fields_values ?? []).find((f: any) => f.field_id === fieldId)
  return f?.values?.[0]?.value ?? null
}

async function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

async function amoGet(path: string): Promise<any> {
  const resp = await fetch(`${AMO_BASE}/api/v4${path}`, {
    headers: { Authorization: `Bearer ${AMO_TOKEN}` },
  })
  if (resp.status === 204) return null
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`amoCRM GET ${path} → ${resp.status}: ${text.slice(0, 200)}`)
  }
  return resp.json()
}

async function amoPatch(path: string, body: unknown): Promise<void> {
  const resp = await fetch(`${AMO_BASE}/api/v4${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${AMO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`amoCRM PATCH ${path} → ${resp.status}: ${text.slice(0, 300)}`)
  }
}

async function fetchAllTildaLeads(): Promise<any[]> {
  const all: any[] = []
  let page = 1
  while (true) {
    await sleep(DELAY_MS)
    const data = await amoGet(
      `/leads?query=${encodeURIComponent(TILDA_LEAD_NAME)}&limit=250&page=${page}&with=custom_fields`
    )
    const leads: any[] = data?._embedded?.leads ?? []
    if (leads.length === 0) break
    // exact name guard: query may return partial-match leads
    all.push(...leads.filter((l: any) => l.name === TILDA_LEAD_NAME))
    if (leads.length < 250) break
    page++
  }
  return all
}

async function main() {
  for (const [key, id] of Object.entries(F)) {
    if (!id) { console.error(`Не задан env AMOCRM_FIELD_${key.toUpperCase()}_ID`); process.exit(1) }
  }

  console.log(`Загружаем все лиды "${TILDA_LEAD_NAME}"...`)
  const all = await fetchAllTildaLeads()
  console.log(`Найдено всего: ${all.length} лидов`)

  const toProcess = all.filter(l => {
    const track = getFieldValue(l, F.cdekTrack)
    if (!track) return false
    return !getFieldValue(l, F.trackLink) || !getFieldValue(l, F.barcode)
  })

  console.log(`Требуют обработки (есть трек, нет ссылки и/или штрихкода): ${toProcess.length}`)
  if (toProcess.length === 0) {
    console.log('Всё уже заполнено.')
    return
  }
  console.log('Начинаем обработку...\n')

  let done = 0, errors = 0
  const errorLog: string[] = []

  for (const lead of toProcess) {
    const track = getFieldValue(lead, F.cdekTrack)!
    const hasLink = !!getFieldValue(lead, F.trackLink)
    const hasBarcode = !!getFieldValue(lead, F.barcode)
    const leadId = lead.id as number

    console.log(`Лид ${leadId}  трек ${track}  [ссылка:${hasLink ? '✓' : '✗'}  штрихкод:${hasBarcode ? '✓' : '✗'}]`)

    const fields: any[] = []

    if (!hasLink) {
      fields.push({
        field_id: F.trackLink,
        values: [{ value: `https://lk.cdek.ru/order-history/${track}/view` }],
      })
    }

    if (!hasBarcode) {
      try {
        await sleep(DELAY_MS)
        const uuid = await getCdekUuidByTrack(track)
        if (!uuid) {
          const msg = `  [WARN] UUID не найден для трека ${track} — штрихкод пропущен`
          console.warn(msg)
          errorLog.push(msg)
        } else {
          console.log(`  UUID: ${uuid}, скачиваем штрихкод...`)
          const pdfBuffer = await downloadCdekBarcode(uuid)
          const s3Url = await uploadBufferToS3(`cdek-barcodes/${uuid}.pdf`, pdfBuffer, 'application/pdf')
          fields.push({ field_id: F.barcode, values: [{ value: s3Url }] })
          console.log(`  Штрихкод → ${s3Url}`)
        }
      } catch (e: any) {
        const msg = `  [ERR] лид ${leadId} штрихкод: ${e?.message}`
        console.error(msg)
        errorLog.push(msg)
        errors++
      }
    }

    if (fields.length === 0) {
      console.log(`  (нечего обновлять — штрихкод не получен)`)
      continue
    }

    try {
      await sleep(DELAY_MS)
      await amoPatch(`/leads/${leadId}`, { custom_fields_values: fields })
      console.log(`  [OK] лид ${leadId} обновлён`)
      done++
    } catch (e: any) {
      const msg = `  [ERR] лид ${leadId} PATCH: ${e?.message}`
      console.error(msg)
      errorLog.push(msg)
      errors++
    }
  }

  console.log(`\nГотово. Обновлено: ${done}, ошибок: ${errors}`)
  if (errorLog.length > 0) {
    console.log('\nСписок предупреждений и ошибок:')
    errorLog.forEach(m => console.log(m))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
