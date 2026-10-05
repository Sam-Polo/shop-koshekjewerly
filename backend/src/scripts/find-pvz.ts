/**
 * One-off diagnostic (read-only): поиск кода ПВЗ СДЭК по городу и куску адреса.
 * pvzCode не сохраняется в Sheets, поэтому для ручного пересоздания отправления
 * его приходится находить обратно по адресу из заказа.
 * Usage: npx tsx src/scripts/find-pvz.ts "Тольятти" "70 лет Октября"
 */
import 'dotenv/config'
import { searchCities, getPickupPoints } from '../cdek.js'

async function main() {
  const cityQuery = process.argv[2]
  const addressPart = (process.argv[3] ?? '').toLowerCase()

  const cities = await searchCities(cityQuery)
  console.log('=== города ===')
  for (const c of cities) console.log(` code=${c.code} | ${c.city} | ${c.region ?? ''} | ${c.country_code ?? ''}`)

  const ru = cities.filter(c => !c.country_code || c.country_code === 'RU')
  if (ru.length === 0) { console.log('город не найден'); return }

  for (const city of ru) {
    const points = await getPickupPoints(city.code)
    const matched = addressPart
      ? points.filter(p => p.address.toLowerCase().includes(addressPart))
      : points
    if (matched.length === 0) continue
    console.log(`\n=== ПВЗ в ${city.city} (code=${city.code}), совпадений ${matched.length} из ${points.length} ===`)
    for (const p of matched) {
      console.log(` code=${p.code}\n   name: ${p.name}\n   addr: ${p.address}\n   time: ${p.work_time ?? ''}`)
    }
  }
}

main().catch(e => { console.error('FATAL:', e?.message ?? e); process.exit(1) })
