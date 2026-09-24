import { initLandscape } from './components/landscape'
import { initSceneCursor } from './components/scene-cursor'

let cleanup: (() => void) | undefined

function start() {
  if (cleanup) return
  const landscape = document.querySelector<HTMLDivElement>('#landscape')
  const cursor = document.querySelector<HTMLDivElement>('.scene-cursor')
  const stopLandscape = landscape ? initLandscape(landscape) : undefined
  const stopCursor = cursor ? initSceneCursor(cursor) : undefined
  cleanup = () => {
    stopCursor?.()
    stopLandscape?.()
  }
}

function stop() {
  cleanup?.()
  cleanup = undefined
}

function restore(event: PageTransitionEvent) {
  if (event.persisted) start()
}

start()
window.addEventListener('pagehide', stop)
window.addEventListener('pageshow', restore)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stop()
    window.removeEventListener('pagehide', stop)
    window.removeEventListener('pageshow', restore)
  })
}
