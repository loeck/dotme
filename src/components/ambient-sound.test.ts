// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { required } from '../invariant'
import { initAmbientSound } from './ambient-sound'

const mixer = vi.hoisted(() => ({
  load: vi.fn<() => Promise<void>>(),
  resume: vi.fn<() => void>(),
  pause: vi.fn<() => void>(),
  dispose: vi.fn<() => void>(),
  setEnvironment: vi.fn<() => void>(),
}))
vi.mock('../audio/ambient-mixer', () => ({
  AmbientMixer: class {
    load = mixer.load
    resume = mixer.resume
    pause = mixer.pause
    dispose = mixer.dispose
    setEnvironment = mixer.setEnvironment
  },
}))
class TestAudioContext {
  state: AudioContextState = 'suspended'
  async resume() {
    this.state = 'running'
  }
  async suspend() {
    this.state = 'suspended'
  }
  async close() {
    this.state = 'closed'
  }
}
let dispose: (() => void) | undefined
beforeEach(() => {
  vi.clearAllMocks()
  mixer.load.mockResolvedValue()
  vi.stubGlobal('AudioContext', TestAudioContext)
  document.body.innerHTML =
    '<button class="scene-sound-trigger" hidden><svg><path data-sound-state></path></svg></button><span data-sound-status></span>'
})
afterEach(() => {
  dispose?.()
  dispose = undefined
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
