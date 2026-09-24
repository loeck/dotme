import type { AmbientMixer } from '../audio/ambient-mixer'
import type { AmbientEnvironment } from '../audio/environment'

export function initAmbientSound(autoplay = true) {
  const button = document.querySelector<HTMLButtonElement>('.scene-sound-trigger')
  const status = document.querySelector<HTMLElement>('[data-sound-status]')
  const lifetime = new AbortController()
  let context: AudioContext | undefined, mixer: AmbientMixer | undefined
  let environment: AmbientEnvironment = {
    solarHour: 0,
    daylight: 0,
    windSpeed: 0,
    rainIntensity: 0,
  }
  let enabled = false,
    requested = false,
    loaded = false,
    generation = 0
  let suspension: ReturnType<typeof setTimeout> | undefined

  const display = (loading = false, message = '') => {
    if (!button) return
    button.setAttribute('aria-pressed', String(enabled))
    button.setAttribute(
      'aria-label',
      loading
        ? 'Cancel ambient sound loading'
        : enabled
          ? 'Disable ambient sound'
          : 'Enable ambient sound',
    )
    button.setAttribute('aria-busy', String(loading))
    button.dataset.loading = String(loading)
    const icon = button.querySelector('[data-sound-state]')
    icon?.setAttribute(
      'd',
      enabled ? 'M16 9a5 5 0 0 1 0 6 M19 6a9 9 0 0 1 0 12' : 'M16 9l6 6 M22 9l-6 6',
    )
    if (status) status.textContent = message
    button.dispatchEvent(new Event('scene-icon-change', { bubbles: true }))
  }
  const disable = (message = '') => {
    enabled = false
    requested = false
    loaded = false
    generation++
    mixer?.dispose(document.hidden ? 0 : 0.3)
    mixer = undefined
    clearTimeout(suspension)
    const current = context
    suspension = setTimeout(() => {
      void current?.suspend().catch(() => {})
    }, 340)
    display(false, message)
  }
  const failure = () => disable('Ambient sound is unavailable. Please try again.')

  const enable = async (automatic = false) => {
    if (lifetime.signal.aborted || (automatic && document.hidden)) return
    requested = true
    const version = ++generation
    const isCurrent = () => requested && version === generation
    clearTimeout(suspension)
    display(true)
    try {
      // Creation/resume still happen synchronously, before the first await, so
      // explicit activation retains the browser's original user gesture.
      if (!context || context.state === 'closed') context = new AudioContext({ sampleRate: 32000 })
      const audioContext = context
      const resumed = audioContext.resume()
      if (automatic)
        await Promise.race([resumed, new Promise<void>((resolve) => setTimeout(resolve, 300))])
      else await resumed
      if (!isCurrent()) return
      if (audioContext.state !== 'running') {
        disable()
        return
      }
      // No mixer or MP3 download until the browser has actually allowed playback.
      const { AmbientMixer } = await import('../audio/ambient-mixer')
      if (!isCurrent()) return
      const instance = new AmbientMixer(audioContext)
      mixer = instance
      instance.setEnvironment(environment)
      await instance.load()
      if (!isCurrent()) return
      loaded = true
      if (document.hidden) {
        instance.pause()
        await audioContext.suspend()
      } else {
        if (audioContext.state !== 'running') throw new Error('Audio suspended')
        instance.resume()
        enabled = true
      }
      if (isCurrent()) display()
    } catch {
      if (!isCurrent()) return
      if (automatic && !mixer) disable()
      else failure()
    }
  }

  button?.addEventListener(
    'click',
    () => {
      if (requested) disable()
      else void enable()
    },
    { signal: lifetime.signal },
  )

  document.addEventListener(
    'visibilitychange',
    () => {
      clearTimeout(suspension)
      if (!context || !requested || !loaded) return
      if (document.hidden) {
        mixer?.pause()
        const version = generation
        suspension = setTimeout(() => {
          if (requested && version === generation && document.hidden)
            void context?.suspend().catch(() => {
              if (version === generation) failure()
            })
        }, 50)
      } else {
        const version = generation
        void context
          .resume()
          .then(() => {
            if (requested && version === generation && !document.hidden) {
              if (context?.state !== 'running') failure()
              else {
                mixer?.resume()
                enabled = true
                display()
              }
            }
            return undefined
          })
          .catch(() => {
            if (version === generation) failure()
          })
      }
    },
    { signal: lifetime.signal },
  )
  if (button) button.hidden = false
  display()
  if (autoplay) void enable(true)
  return {
    startAutoplay() {
      // An explicit choice made during preparation always wins over delayed autoplay.
      if (generation === 0) void enable(true)
    },
    setEnvironment(state: AmbientEnvironment) {
      environment = state
      mixer?.setEnvironment(state)
    },
    dispose() {
      lifetime.abort()
      disable()
      clearTimeout(suspension)
      void context?.close().catch(() => {})
      context = undefined
      if (button) {
        button.hidden = true
        button.disabled = false
      }
    },
  }
}
