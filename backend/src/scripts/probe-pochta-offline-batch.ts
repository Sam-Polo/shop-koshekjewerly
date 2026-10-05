/**
 * One-off diagnostic: проверяет, доступны ли печатные формы при партии БЕЗ
 * use-online-balance=true («классическая» схема оплаты — деньги на стойке).
 *
 * Контекст: в июле 2026 по совету техподдержки Почты в createBatch добавили
 * ?use-online-balance=true — считалось, что классическая схема на аккаунте
 * отключена и потому формы отдают 403. Проверка живым тестом (август 2026)
 * показала: с онлайн-балансом формы всё равно 403 (code 1007 UNAUTHORIZED),
 * в ЛК при ручном скачивании — «недостаточно средств».
 *
 * Этот скрипт гоняет тот же пайплайн, но партию создаёт БЕЗ флага. Цель —
 * ответить: классическая схема действительно отключена (снова 403), или она
 * жива и флаг был лишним (формы скачаются).
 *
 * Создаёт ОДИН тестовый заказ + партию в ЛК Почты. Это бесплатно (деньги
 * списываются только при физической сдаче), но мусор потом удалить вручную:
 * otpravka.pochta.ru → Заказы / Партии.
 *
 * Usage: npx tsx src/scripts/probe-pochta-offline-batch.ts
 */
import 'dotenv/config'
import { pochtaFetch, createPochtaOrder, getShpiFromBatch, downloadF7p, checkRequiredPochtaEnv } from '../pochta.js'

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

// тот же фейковый заказ, что и в /api/pochta/test (Германия, дальнее зарубежье)
const fakeOrder = {
  orderId: `PROBE-EMS-${Date.now()}`,
  status: 'paid' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  platform: 'telegram' as const,
  customerChatId: '123456789',
  customerName: 'Тест Тестов',
  orderData: {
    fullName: 'Ivan Petrov',
    phone: '+79991234567',
    country: '', city: '', address: '',
    deliveryRegion: '',
    deliveryCost: 0,
    total: 5000,
    deliveryMethod: 'ems' as const,
    recipientCountry: 'Germany',
    recipientCountryCode: 276,
    recipientRegion: 'Berlin',
    recipientCity: 'Berlin',
    recipientStreet: 'Teststrasse 1',
    recipientIndex: '10115',
    items: [{ slug: 'test-ring', title: 'Test ring', price: 5000, quantity: 1 }],
  },
}

async function main() {
  if (!checkRequiredPochtaEnv()) {
    console.error('POCHTA env не заданы — нечего проверять')
    process.exit(1)
  }

  console.log('=== 1) Заказ в backlog ===')
  const order = await createPochtaOrder(fakeOrder as any)
  console.log('order id:', order.id)

  console.log('\n=== 2) Партия БЕЗ use-online-balance (классическая схема) ===')
  const batchResp = await pochtaFetch('POST', '/1.0/user/shipment', [order.id]) as any
  console.log(JSON.stringify(batchResp, null, 2).slice(0, 800))
  const batchName = Array.isArray(batchResp)
    ? batchResp[0]?.['batch-name']
    : batchResp?.['batch-name'] ?? batchResp?.batches?.[0]?.['batch-name']
  if (!batchName) {
    console.error('batch-name не получен — дальше идти некуда')
    process.exit(1)
  }
  console.log('batch-name:', batchName)

  console.log('\n=== 3) ШПИ ===')
  let shpi: string | null = null
  for (let i = 0; i < 5; i++) {
    try {
      shpi = await getShpiFromBatch(batchName)
      if (shpi) break
    } catch (e: any) {
      console.log('  попытка', i + 1, 'ошибка:', e?.message)
    }
    await sleep(3000)
  }
  console.log('ШПИ:', shpi ?? '(не присвоен за 15с)')

  console.log('\n=== 4) ГЛАВНОЕ: печатные формы по заказу', order.id, '===')
  try {
    const pdf = await downloadF7p(order.id)
    console.log(`✅ ФОРМЫ СКАЧАЛИСЬ: ${pdf.length} байт`)
  } catch (e: any) {
    console.log('❌ формы недоступны:', e?.message)
  }
  // ИТОГ проверки 04.08.2026: доступность форм определяется видом отправления, а не
  // этим флагом. EMS+ORDINARY → PDF отдаётся (с флагом и без), SMALL_PACKET+ORDERED
  // (прод) → 403 на всех эндпоинтах форм. Гонять скрипт с POCHTA_MAIL_TYPE того вида,
  // который проверяете: npx tsx ... с POCHTA_MAIL_TYPE=SMALL_PACKET POCHTA_MAIL_CATEGORY=ORDERED

  console.log(`\nУдалить мусор в ЛК: заказ ${order.id}, партия ${batchName}`)
}

main().catch(e => { console.error(e); process.exit(1) })
