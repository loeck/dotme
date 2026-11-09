import type { AmbientMixer } from '../audio/ambient-mixer'
import type { AmbientEnvironment, AmbientWeather } from '../audio/environment'
import { primeMediaElement } from '../audio/media-unlock'
import type { SkipNoteEvent } from '../audio/skip-notes'
import type { ThunderEvent } from '../audio/thunder'
import type { WaterSoundEvent } from '../audio/water-sounds'
import { reducedMotionQuery, storage } from '../env'

/** localStorage key holding "off" once the visitor has turned the sound off. */
export const SOUND_PREFERENCE_KEY = 'dotme:sound'

/** Whether the visitor turned the sound off on an earlier visit (or earlier in this one). */
export function soundTurnedOff() {
  try {
    return storage()?.getItem(SOUND_PREFERENCE_KEY) === 'off'
  } catch {
    return false
  }
}

function rememberChoice(on: boolean) {
  try {
    const store = storage()
    if (on) store?.removeItem(SOUND_PREFERENCE_KEY)
    else store?.setItem(SOUND_PREFERENCE_KEY, 'off')
  } catch {
    /* Storage may be full or disabled; the choice then lasts for this page only. */
  }
}

const INTERRUPTED_MESSAGE = 'Ambient sound was paused by the system. Tap or press a key to resume.'

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
  let weather: AmbientWeather = {}
  const motion = typeof matchMedia === 'function' ? reducedMotionQuery() : undefined
  const mixed = (): AmbientEnvironment => ({
    ...environment,
    ...weather,
    reducedMotion: motion?.matches ?? false,
  })
  let enabled = false,
    requested = false,
    loaded = false,
    // The system (another app, a call, iOS audio session) suspended a context we had running.
    interrupted = false,
    // The visitor already clicked the button once to resume an interruption.
    retriedInterruption = false,
    // Our own visibility suspend/resume is in flight: its "suspended" is not an interruption.
    ownTransition = 0,
    generation = 0
  let suspension: ReturnType<typeof setTimeout> | undefined
  let gestures: AbortController | undefined

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
  const stopGestureResume = () => {
    gestures?.abort()
    gestures = undefined
  }
  const disable = (message = '') => {
    enabled = false
    requested = false
    loaded = false
    interrupted = false
    retriedInterruption = false
    generation++
    stopGestureResume()
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

  /** Back to playing after a resume, whoever asked for it. */
  const playing = () => {
    if (!requested || !loaded || document.hidden || context?.state !== 'running') return
    interrupted = false
    retriedInterruption = false
    stopGestureResume()
    mixer?.resume()
    enabled = true
    display()
  }

  /**
   * iOS and Safari suspend (or report "interrupted") a running context on their own: a call,
   * another app taking the audio session, the screen locking. The button turns off while the
   * sound is silent, and the next tap or key press anywhere on the page, a user gesture,
   * resumes it.
   */
  const onStateChange = () => {
    const state: string = context?.state ?? 'closed'
    if (!requested || !loaded || document.hidden) return
    if (state === 'running') {
      playing()
      return
    }
    if (state === 'suspended' && ownTransition > 0) return
    if (state !== 'suspended' && state !== 'interrupted') return
    interrupt()
  }
  const interrupt = () => {
    if (!interrupted) retriedInterruption = false
    interrupted = true
    mixer?.pause()
    enabled = false
    display(false, INTERRUPTED_MESSAGE)
    if (gestures) return
    gestures = new AbortController()
    const retry = () => {
      if (!interrupted || !context) return
      void context.resume().catch(() => {})
    }
    for (const type of ['pointerdown', 'keydown'] as const)
      document.addEventListener(type, retry, { capture: true, signal: gestures.signal })
  }

  const enable = async (automatic = false) => {
    if (lifetime.signal.aborted || (automatic && document.hidden)) return
    // A visitor who turned the sound off keeps it off until they turn it on again.
    if (automatic && soundTurnedOff()) return
    requested = true
    interrupted = false
    const version = ++generation
    const isCurrent = () => requested && version === generation
    clearTimeout(suspension)
    display(true)
    try {
      // Creation/resume still happen synchronously, before the first await, so
      // explicit activation retains the browser's original user gesture.
      if (!context || context.state === 'closed') {
        context = new AudioContext({ sampleRate: 32000 })
        context.addEventListener('statechange', onStateChange, { signal: lifetime.signal })
      }
      const audioContext = context
      const resumed = audioContext.resume()
      // The music element must also first play inside the gesture to be allowed later (WebKit).
      const musicElement = automatic ? undefined : primeMediaElement()
      if (automatic)
        await Promise.race([resumed, new Promise<void>((resolve) => setTimeout(resolve, 300))])
      else await resumed
      if (!isCurrent()) return
      if (audioContext.state !== 'running') {
        disable()
        return
      }
      // No mixer or audio download until the browser has actually allowed playback.
      const { AmbientMixer } = await import('../audio/ambient-mixer')
      if (!isCurrent()) return
      const format = new Audio().canPlayType('audio/ogg; codecs="opus"') ? 'ogg' : 'mp3'
      const instance = new AmbientMixer(audioContext, format, { media: audioContext, musicElement })
      mixer = instance
      instance.setEnvironment(mixed())
      await instance.load()
      if (!isCurrent()) return
      loaded = true
      if (document.hidden) {
        instance.pause()
        await audioContext.suspend()
      } else {
        if (audioContext.state !== 'running') {
          // The system interrupted the context while the clips loaded: wait for a gesture.
          interrupt()
          return
        }
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
      if (interrupted && context) {
        // A second click, or a refused resume, means "off": the visitor gave up on resuming.
        const giveUp = () => {
          rememberChoice(false)
          disable()
        }
        if (retriedInterruption) {
          giveUp()
          return
        }
        // The click is itself a gesture: resume the interrupted sound instead of stopping it.
        retriedInterruption = true
        const version = generation
        void context.resume().catch(() => {
          if (interrupted && version === generation) giveUp()
        })
        return
      }
      if (requested) {
        rememberChoice(false)
        disable()
      } else {
        rememberChoice(true)
        void enable()
      }
    },
    { signal: lifetime.signal },
  )

  motion?.addEventListener('change', () => mixer?.setEnvironment(mixed()), {
    signal: lifetime.signal,
  })

  document.addEventListener(
    'visibilitychange',
    () => {
      clearTimeout(suspension)
      if (!context || !requested || !loaded) return
      if (document.hidden) {
        mixer?.pause()
        const version = generation
        suspension = setTimeout(() => {
          if (!context || !requested || version !== generation || !document.hidden) return
          ownTransition++
          void context
            .suspend()
            .catch(() => {
              if (version === generation) failure()
            })
            .finally(() => ownTransition--)
        }, 50)
      } else {
        const version = generation
        ownTransition++
        void context
          .resume()
          .finally(() => ownTransition--)
          .then(() => {
            if (requested && version === generation && !document.hidden) {
              if (context?.state !== 'running') failure()
              else playing()
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
      mixer?.setEnvironment(mixed())
    },
    /**
     * The scene's weather beyond what the engine reports each frame: temperature, fog, snow and
     * storms (a `SceneWeather` fits). Call it with the preloaded weather and after each refresh.
     */
    setWeather(state: Pick<AmbientWeather, 'temperature' | 'fog' | 'snow' | 'storm'>) {
      weather = {
        ...(state.temperature === undefined ? {} : { temperature: state.temperature }),
        ...(state.fog === undefined ? {} : { fog: state.fog }),
        ...(state.snow === undefined ? {} : { snow: state.snow }),
        ...(state.storm === undefined ? {} : { storm: state.storm }),
      }
      mixer?.setEnvironment(mixed())
    },
    waterSound(event: WaterSoundEvent) {
      mixer?.waterSound(event)
    },
    skipNote(event: SkipNoteEvent) {
      mixer?.skipNote(event)
    },
    thunder(event: ThunderEvent) {
      mixer?.thunder(event)
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
