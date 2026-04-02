// Платформенный адаптер для WebApp API
//
// Telegram: window.Telegram.WebApp — инжектируется самим Telegram,
//           @twa-dev/sdk экспортирует его как типизированный объект.
//
// MAX:      window.WebApp — устанавливается CDN-скриптом MAX Bridge,
//           подключённым в index.html ДО загрузки модулей (тег <script> без defer/async).
//           API идентично Telegram по используемым нами методам.
//
// Обнаружение платформы: Telegram всегда имеет window.Telegram.WebApp,
// MAX устанавливает window.WebApp без window.Telegram. Порядок проверки важен:
// сначала Telegram, затем MAX.

import TelegramWebApp from '@twa-dev/sdk'

declare global {
  interface Window {
    // MAX Bridge устанавливает window.WebApp (не Telegram.WebApp)
    WebApp?: typeof TelegramWebApp
  }
}

function detectPlatform(): 'telegram' | 'max' {
  if (typeof window === 'undefined') return 'telegram'
  // Telegram инжектирует window.Telegram.WebApp
  if ((window as any).Telegram?.WebApp) return 'telegram'
  // MAX Bridge устанавливает window.WebApp
  if (window.WebApp) return 'max'
  // fallback — считаем Telegram (initData будет пустым, но код не сломается)
  return 'telegram'
}

export const platform: 'telegram' | 'max' = detectPlatform()

// Единый объект WebApp вне зависимости от платформы.
// Используемые методы (ready, initData, initDataUnsafe, openLink, BackButton, close)
// присутствуют в обоих SDK с одинаковыми сигнатурами.
const WebApp = platform === 'max' ? window.WebApp! : TelegramWebApp

export default WebApp
