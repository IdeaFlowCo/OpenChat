import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { initClientLogging } from './utils/clientLogger'
import { initInstallPromptCapture } from './utils/installPrompt'
import './index.css'

initClientLogging()
// Capture `beforeinstallprompt` as early as possible — Chrome fires it
// exactly once, very early in the page lifecycle. If no listener exists
// when it fires, the event is lost and the user has to navigate away
// and back to retrigger.
initInstallPromptCapture()

// Track the *visible* viewport height in --app-height so the app shrinks
// correctly when the iOS keyboard opens. 100dvh in CSS does NOT account
// for the soft keyboard — without this, opening the keyboard pushed the
// chat area off-screen and the user saw a blank white screen until they
// dismissed the keyboard. See OpenChat-ka1.
//
// rAF-debounced: visualViewport.resize fires multiple times during the
// iOS keyboard animation; writing the CSS var on every tick causes visible
// height jitter. Coalescing to one update per animation frame smooths it.
// Per codex review 2026-05-30.
let appHeightRaf: number | null = null
function syncAppHeight(): void {
  if (appHeightRaf !== null) return
  appHeightRaf = requestAnimationFrame(() => {
    appHeightRaf = null
    const vv = window.visualViewport
    const h = vv?.height ?? window.innerHeight
    document.documentElement.style.setProperty('--app-height', `${h}px`)
  })
}
// One synchronous write at boot so the first paint already has the right value.
{
  const vv = window.visualViewport
  const h = vv?.height ?? window.innerHeight
  document.documentElement.style.setProperty('--app-height', `${h}px`)
}
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
