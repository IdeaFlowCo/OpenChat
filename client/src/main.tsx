import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { initClientLogging } from './utils/clientLogger'
import './index.css'

initClientLogging()

// Track the *visible* viewport height in --app-height so the app shrinks
// correctly when the iOS keyboard opens. 100dvh in CSS does NOT account
// for the soft keyboard — without this, opening the keyboard pushed the
// chat area off-screen and the user saw a blank white screen until they
// dismissed the keyboard. See OpenChat-ka1.
function syncAppHeight(): void {
  const vv = window.visualViewport
  const h = vv?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--app-height', `${h}px`)
}
syncAppHeight()
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncAppHeight)
  window.visualViewport.addEventListener('scroll', syncAppHeight)
} else {
  window.addEventListener('resize', syncAppHeight)
}

// Register service worker (PWA). Only in production builds — in dev, the
// SW would aggressively cache HMR'd modules and mask the latest changes.
// See OpenChat-t2w / OpenChat-6ha.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => console.warn('SW registration failed:', err))
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
