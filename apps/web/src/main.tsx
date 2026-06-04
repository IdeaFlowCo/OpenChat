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

// Defensive: even with position:fixed on body + #root, iOS Safari has been
// observed to apply an internal "scroll-the-focused-input-into-view" that
// translates the document upward. Whenever ANY input gains focus, snap the
// document scroll back to (0, 0) on the next paint. window.scrollTo on a
// position:fixed body is a no-op in the correct case (cheap, harmless), but
// undoes iOS's nudge in the bad case. Per Jacob's iPhone test 2026-05-30 v2.
function snapScrollToZero(): void {
  // Schedule on next frame so it runs AFTER iOS's own scroll attempt.
  requestAnimationFrame(() => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0)
    }
    if (document.documentElement.scrollTop !== 0) {
      document.documentElement.scrollTop = 0
    }
    if (document.body.scrollTop !== 0) {
      document.body.scrollTop = 0
    }
  })
}
document.addEventListener('focusin', snapScrollToZero, true)
document.addEventListener('scroll', snapScrollToZero, true)
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', snapScrollToZero)
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
