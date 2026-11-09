// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { required } from '../invariant'
import { initAmbientSound, SOUND_PREFERENCE_KEY, soundTurnedOff } from './ambient-sound'

const mixer = vi.hoisted(() => ({
  load: vi.fn<() => Promise<void>>(),
  resume: vi.fn<() => void>(),
  pause: vi.fn<() => void>(),
  dispose: vi.fn<() => void>(),
  setEnvironment: vi.fn<() => void>(),
  create: vi.fn<(context: unknown, format: string) => void>(),
}))
vi.mock('../audio/ambient-mixer', () => ({
  AmbientMixer: class {
    constructor(context: unknown, format: string) {
      mixer.create(context, format)
    }
    load = mixer.load
    resume = mixer.resume
    pause = mixer.pause
    dispose = mixer.dispose
    setEnvironment = mixer.setEnvironment
  },
}))
class TestAudioContext extends EventTarget {
  static last: TestAudioContext | undefined
  state: string = 'suspended'
  constructor() {
    super()
    TestAudioContext.last = this
  }
  /** As browsers do: a state change, then a `statechange` event. */
  set(state: string) {
    if (this.state === state) return
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
  async resume() {
    this.set('running')
  }
  async suspend() {
    this.set('suspended')
  }
  async close() {
    this.set('closed')
  }
}
let dispose: (() => void) | undefined
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  TestAudioContext.last = undefined
  mixer.load.mockResolvedValue()
  vi.stubGlobal('AudioContext', TestAudioContext)
  document.body.innerHTML =
    '<button class="scene-sound-trigger" hidden><svg><path data-sound-state></path></svg></button><span data-sound-status></span>'
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  setHidden(false)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function pendingLoad() {
  let finish: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    promise,
    complete() {
      required(finish)()
    },
  }
}
function button() {
  return required(document.querySelector<HTMLButtonElement>('.scene-sound-trigger'))
}

it('never displays enabled sound when autoplay is rejected', async () => {
  vi.spyOn(TestAudioContext.prototype, 'resume').mockRejectedValue(
    new DOMException('Autoplay blocked', 'NotAllowedError'),
  )
  const attributes = vi.spyOn(button(), 'setAttribute')
  const sound = initAmbientSound()
  dispose = () => sound.dispose()
  await vi.waitFor(() => expect(button().getAttribute('aria-busy')).toBe('false'))
  expect(button().getAttribute('aria-pressed')).toBe('false')
  expect(attributes.mock.calls).not.toContainEqual(['aria-pressed', 'true'])
  expect(mixer.load).not.toHaveBeenCalled()
})

it('keeps the icon off while loading and enables it only after playback starts', async () => {
  const pending = pendingLoad()
  mixer.load.mockReturnValue(pending.promise)
  const sound = initAmbientSound(false)
  dispose = () => sound.dispose()
  button().click()
  await vi.waitFor(() => expect(mixer.load).toHaveBeenCalledOnce())
  expect(button().getAttribute('aria-pressed')).toBe('false')
  expect(button().getAttribute('aria-busy')).toBe('true')
  expect(button().getAttribute('aria-label')).toBe('Cancel ambient sound loading')
  expect(mixer.resume).not.toHaveBeenCalled()
  pending.complete()
  await vi.waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'))
  expect(mixer.resume).toHaveBeenCalledOnce()
  expect(button().getAttribute('aria-busy')).toBe('false')
})

for (const [support, format] of [
  ['probably', 'ogg'],
  ['', 'mp3'],
] as const)
  it(`loads ${format} audio when Opus support is "${support}"`, async () => {
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue(support)
    const sound = initAmbientSound(false)
    dispose = () => sound.dispose()
    button().click()
    await vi.waitFor(() => expect(mixer.create).toHaveBeenCalledOnce())
    expect(canPlayType).toHaveBeenCalledWith('audio/ogg; codecs="opus"')
    expect(mixer.create).toHaveBeenCalledWith(expect.anything(), format)
  })

it('cancels pending activation on a second click without a late enabled state', async () => {
  const pending = pendingLoad()
  mixer.load.mockReturnValue(pending.promise)
  const attributes = vi.spyOn(button(), 'setAttribute')
  const sound = initAmbientSound(false)
  dispose = () => sound.dispose()
  button().click()
  await vi.waitFor(() => expect(mixer.load).toHaveBeenCalledOnce())
  button().click()
  expect(button().getAttribute('aria-busy')).toBe('false')
  pending.complete()
  await Promise.resolve()
  expect(button().getAttribute('aria-pressed')).toBe('false')
  expect(attributes.mock.calls).not.toContainEqual(['aria-pressed', 'true'])
  expect(mixer.resume).not.toHaveBeenCalled()
  expect(mixer.dispose).toHaveBeenCalled()
})

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
}
function audio() {
  return required(TestAudioContext.last)
}
async function enabled() {
  const sound = initAmbientSound(false)
  dispose = () => sound.dispose()
  button().click()
  await vi.waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'))
  return sound
}

it('remembers turning the sound off, skips autoplay next time, and forgets on turning it on', async () => {
  await enabled()
  button().click()
  expect(button().getAttribute('aria-pressed')).toBe('false')
  expect(localStorage.getItem(SOUND_PREFERENCE_KEY)).toBe('off')
  expect(soundTurnedOff()).toBe(true)
  dispose?.()
  vi.clearAllMocks()
  // The next visit: autoplay does not even create a context.
  const resume = vi.spyOn(TestAudioContext.prototype, 'resume')
  const next = initAmbientSound()
  dispose = () => next.dispose()
  next.startAutoplay()
  await Promise.resolve()
  expect(resume).not.toHaveBeenCalled()
  expect(mixer.create).not.toHaveBeenCalled()
  button().click()
  await vi.waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'))
  expect(localStorage.getItem(SOUND_PREFERENCE_KEY)).toBeNull()
})

it('keeps sound working when storage throws', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Denied', 'SecurityError')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Full', 'QuotaExceededError')
  })
  expect(soundTurnedOff()).toBe(false)
  await enabled()
  expect(() => button().click()).not.toThrow()
  expect(button().getAttribute('aria-pressed')).toBe('false')
})

it('pauses while hidden and resumes when visible again', async () => {
  vi.useFakeTimers()
  try {
    await enabled()
    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mixer.pause).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60)
    expect(audio().state).toBe('suspended')
    // The system's own suspension of a hidden page is not an interruption.
    expect(button().getAttribute('aria-pressed')).toBe('true')
    mixer.resume.mockClear()
    setHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(audio().state).toBe('running')
    expect(mixer.resume).toHaveBeenCalled()
    expect(button().getAttribute('aria-pressed')).toBe('true')
  } finally {
    vi.useRealTimers()
  }
})

for (const state of ['suspended', 'interrupted'])
  it(`shows a system ${state} context as off and resumes on the next gesture`, async () => {
    await enabled()
    const resume = vi.spyOn(audio(), 'resume').mockResolvedValue()
    audio().set(state)
    expect(mixer.pause).toHaveBeenCalledOnce()
    expect(button().getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[data-sound-status]')?.textContent).toMatch(/resume/)
    // Not the user's choice: nothing is remembered.
    expect(localStorage.getItem(SOUND_PREFERENCE_KEY)).toBeNull()
    document.dispatchEvent(new Event('pointerdown'))
    expect(resume).toHaveBeenCalledOnce()
    mixer.resume.mockClear()
    audio().set('running')
    expect(mixer.resume).toHaveBeenCalledOnce()
    expect(button().getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-sound-status]')?.textContent).toBe('')
    // Gesture listeners are gone once running again.
    document.dispatchEvent(new Event('keydown'))
    expect(resume).toHaveBeenCalledOnce()
  })

it('treats a click on an interrupted sound as resuming it, not turning it off', async () => {
  await enabled()
  audio().set('interrupted')
  button().click()
  await vi.waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'))
  expect(mixer.dispose).not.toHaveBeenCalled()
  expect(localStorage.getItem(SOUND_PREFERENCE_KEY)).toBeNull()
})

it('turns an interrupted sound off on a second click or a refused resume', async () => {
  await enabled()
  const resume = vi.spyOn(audio(), 'resume').mockResolvedValue()
  audio().set('interrupted')
  button().click()
  expect(resume).toHaveBeenCalledOnce()
  // Still silent: the second click means "off", remembered like any other.
  button().click()
  expect(button().getAttribute('aria-pressed')).toBe('false')
  expect(mixer.dispose).toHaveBeenCalledOnce()
  expect(localStorage.getItem(SOUND_PREFERENCE_KEY)).toBe('off')
  // The page-wide gesture listeners are gone.
  document.dispatchEvent(new Event('pointerdown'))
  expect(resume).toHaveBeenCalledOnce()

  resume.mockRestore()
  localStorage.clear()
  button().click()
  await vi.waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'))
  mixer.dispose.mockClear()
  vi.spyOn(audio(), 'resume').mockRejectedValue(new Error('Refused'))
  audio().set('interrupted')
  button().click()
  await vi.waitFor(() => expect(mixer.dispose).toHaveBeenCalledOnce())
  expect(button().getAttribute('aria-pressed')).toBe('false')
  expect(localStorage.getItem(SOUND_PREFERENCE_KEY)).toBe('off')
})

it('waits for a gesture when the system interrupts the sound while it loads', async () => {
  const load = pendingLoad()
  mixer.load.mockReturnValue(load.promise)
  const sound = initAmbientSound(false)
  dispose = () => sound.dispose()
  button().click()
  await vi.waitFor(() => expect(mixer.load).toHaveBeenCalledOnce())
  audio().set('interrupted')
  load.complete()
  await vi.waitFor(() =>
    expect(document.querySelector('[data-sound-status]')?.textContent).toMatch(/resume/),
  )
  expect(mixer.dispose).not.toHaveBeenCalled()
  document.dispatchEvent(new Event('pointerdown'))
  await vi.waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'))
  expect(mixer.resume).toHaveBeenCalled()
})

it('does not report its own visibility suspension as a system pause', async () => {
  vi.useFakeTimers()
  try {
    await enabled()
    let finish: (() => void) | undefined
    vi.spyOn(audio(), 'resume').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            audio().set('running')
            resolve()
          }
        }),
    )
    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    setHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    // A late `suspended` while our resume is pending is ours, not the system's.
    audio().set('suspended')
    expect(document.querySelector('[data-sound-status]')?.textContent).toBe('')
    required(finish)()
    await vi.advanceTimersByTimeAsync(0)
    expect(button().getAttribute('aria-pressed')).toBe('true')
  } finally {
    vi.useRealTimers()
  }
})

it('merges weather and reduced motion into the environment it gives the mixer', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => Object.assign(new EventTarget(), { matches: true })),
  )
  const sound = await enabled()
  const weather = { temperature: 4, fog: 0.5, snow: 0, storm: true, humidity: 0.9 }
  sound.setWeather(weather)
  expect(mixer.setEnvironment).toHaveBeenLastCalledWith({
    solarHour: 0,
    daylight: 0,
    windSpeed: 0,
    rainIntensity: 0,
    temperature: 4,
    fog: 0.5,
    snow: 0,
    storm: true,
    reducedMotion: true,
  })
  sound.setEnvironment({ solarHour: 12, daylight: 1, windSpeed: 2, rainIntensity: 0.3 })
  expect(mixer.setEnvironment).toHaveBeenLastCalledWith(
    expect.objectContaining({ daylight: 1, temperature: 4, reducedMotion: true }),
  )
})
