import { initLandscape } from './components/landscape'
import { initSceneCursor } from './components/scene-cursor'
import { initSceneInfo } from './components/scene-info'
import { initSceneLoader } from './components/scene-loader'

let cleanup: (() => void) | undefined

function start() {
  if (cleanup) return
  const landscape = document.querySelector<HTMLDivElement>('#landscape')
  const cursor = document.querySelector<HTMLDivElement>('.scene-cursor')
  const loopLoader = new URLSearchParams(window.location.search).get('loader') === 'loop'
  const loader = initSceneLoader(loopLoader)
  const stopLandscape =
    !loopLoader && landscape ? initLandscape(landscape, loader.reveal) : undefined
  if (!loopLoader && !landscape) loader.reveal()
  const stopCursor = cursor ? initSceneCursor(cursor) : undefined
  const stopInfo = !loopLoader ? initSceneInfo() : undefined
  cleanup = () => {
    stopInfo?.()
    stopCursor?.()
    stopLandscape?.()
    loader.dispose()
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
