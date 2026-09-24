import { initAmbientSound } from './components/ambient-sound'
import { initLandscape } from './components/landscape'
import { initSceneCursor } from './components/scene-cursor'
import { initSceneInfo } from './components/scene-info'
import { initSceneLoader } from './components/scene-loader'
import { cleanSceneUrl } from './scene-params'

let cleanup: (() => void) | undefined

function start(autoplay = true) {
  if (cleanup) return
  const landscape = document.querySelector<HTMLDivElement>('#landscape')
  const url = cleanSceneUrl(new URL(window.location.href))
  if (url.href !== window.location.href) history.replaceState(history.state, '', url)
  const loader = initSceneLoader()
  const sound = initAmbientSound(autoplay)
  const stopLandscape = landscape ? initLandscape(landscape, loader.reveal, sound) : undefined
  if (!landscape) loader.reveal()
  const cursor = document.querySelector<HTMLDivElement>('.scene-cursor')
  const stopCursor = cursor ? initSceneCursor(cursor) : undefined
  const stopInfo = initSceneInfo()
  cleanup = () => {
    sound.dispose()
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
  if (event.persisted) start(false)
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
