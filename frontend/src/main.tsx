import React from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import App from './ui/App'
import './ui/styles.css'

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  // только ошибки, без performance-трассировки (экономит квоту free-плана)
  tracesSampleRate: 0,
  // отключаем в dev и когда DSN не задан
  enabled: !!import.meta.env.VITE_SENTRY_DSN && import.meta.env.PROD,
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={
      <p style={{ padding: 16, textAlign: 'center', fontSize: 15 }}>
        Что-то пошло не так. Обновите страницу.
      </p>
    }>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>
)
