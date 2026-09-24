import type { AmbientMixer } from '../audio/ambient-mixer'
import type { AmbientEnvironment } from '../audio/environment'

export function initAmbientSound() {
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
    generation = 0,
    failed = false
  let suspension: ReturnType<typeof setTimeout> | undefined

  const display = (loading = false, message = '') => {
    if (!button) return
    button.setAttribute('aria-pressed', String(enabled))
    button.setAttribute('aria-label', enabled ? 'Disable ambient sound' : 'Enable ambient sound')
    button.setAttribute('aria-busy', String(loading))
    button.dataset.loading = String(loading)
    const icon = button.querySelector('[data-sound-state]')!
    icon.setAttribute(
      'd',
      enabled ? 'M16 9a5 5 0 0 1 0 6 M19 6a9 9 0 0 1 0 12' : 'M16 9l6 6 M22 9l-6 6',
    )
    if (status) status.textContent = message
    button.dispatchEvent(new Event('scene-icon-change', { bubbles: true }))
  }
  const disable = (message = '') => {
    enabled = false
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

  button?.addEventListener(
    'click',
    () => {
      if (enabled) {
        disable()
        return
      }
      if (failed) return
      enabled = true
      const version = ++generation
      clearTimeout(suspension)
      display(true)
      try {
        // The context and resume call must happen in the original user gesture.
        if (!context || context.state === 'closed')
          context = new AudioContext({ sampleRate: 32000 })
        const audioContext = context
        const resumed = audioContext.resume()
        void Promise.all([resumed, import('../audio/ambient-mixer')])
          .then(async ([, module]) => {
            if (!enabled || version !== generation) return
            const instance = new module.AmbientMixer(audioContext)
            mixer = instance
            instance.setEnvironment(environment)
            await instance.load()
            if (!enabled || version !== generation) return
            if (document.hidden) {
              instance.pause()
              await audioContext.suspend()
            } else {
              if (audioContext.state !== 'running') throw new Error('Audio suspended')
              instance.resume()
            }
            display()
            return undefined
          })
          .catch(() => {
            if (version === generation) failure()
          })
      } catch {
        failure()
      }
    },
    { signal: lifetime.signal },
  )

  document.addEventListener(
    'visibilitychange',
    () => {
      clearTimeout(suspension)
      if (!context || !enabled) return
      if (document.hidden) {
        mixer?.pause()
        const version = generation
        suspension = setTimeout(() => {
          if (enabled && version === generation && document.hidden)
            void context?.suspend().catch(failure)
        }, 50)
      } else {
        const version = generation
        void context
          .resume()
          .then(() => {
            if (enabled && version === generation && !document.hidden) {
              if (context?.state !== 'running') failure()
              else mixer?.resume()
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
  return {
    setEnvironment(state: AmbientEnvironment) {
      environment = state
      mixer?.setEnvironment(state)
    },
    fail() {
      failed = true
      disable()
      if (button) button.disabled = true
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
