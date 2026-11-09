// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

import { primeMediaElement } from './media-unlock'
import { AmbientMusic, musicGap, musicMood } from './music'

const at = (daylight: number, rainIntensity = 0) => ({
  daylight,
  rainIntensity,
  solarHour: 12,
  windSpeed: 0,
})

afterEach(() => {
  vi.restoreAllMocks()
})

it('chooses the day piece only in dry daylight and leaves minutes of silence between pieces', () => {
  expect(musicMood(at(1))).toBe('day')
  expect(musicMood(at(0.2))).toBe('night')
  expect(musicMood(at(1, 0.8))).toBe('night')
  expect(musicMood(at(NaN, NaN))).toBe('night')
  expect(musicGap(at(1), () => 0)).toBe(150)
  expect(musicGap(at(1), () => 0.999)).toBeLessThan(300)
  expect(musicGap(at(1, 1), () => 0)).toBe(225)
})

const node = () => ({ connect: vi.fn<() => void>(), disconnect: vi.fn<() => void>() })
function context() {
  return {
    currentTime: 0,
    createGain: () => ({ ...node(), gain: { value: 0 } }),
    createMediaElementSource: vi.fn<(element: HTMLMediaElement) => ReturnType<typeof node>>(() =>
      node(),
    ),
  }
}

it('primes a muted element in the gesture and plays later pieces through it', async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  const element = primeMediaElement()
  expect(element?.muted).toBe(true)
  // A blob: URL, which the CSP's media-src allows (a data: URL is blocked), freed once primed.
  const primed = element?.src
  expect(primed).toMatch(/^blob:/)
  expect(play).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith(primed))
  const audio = context()
  const music = new AmbientMusic(audio, audio.createGain(), () => 'ogg', {
    element,
    firstPiece: 30,
    random: () => 0,
  })
  // The primed element joins the graph at once, while the context is running.
  expect(audio.createMediaElementSource).toHaveBeenCalledWith(element)
  music.tick()
  expect(music.state).toBe('waiting')
  audio.currentTime = 30
  music.tick()
  expect(play).toHaveBeenCalledTimes(2)
  expect(element?.muted).toBe(false)
  expect(element?.src).toMatch(/\/audio\/music-day\.ogg$/)
  expect(music.state).toBe('playing')
  expect(audio.createMediaElementSource).toHaveBeenCalledOnce()
  music.dispose()
})

it('reports a refused piece once and tries again after the usual gap', async () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
    new DOMException('No gesture', 'NotAllowedError'),
  )
  const audio = context()
  const music = new AmbientMusic(audio, audio.createGain(), () => 'mp3', {
    firstPiece: 0,
    random: () => 0,
  })
  music.tick()
  await vi.waitFor(() => expect(music.state).toBe('blocked'))
  expect(debug).toHaveBeenCalledOnce()
  audio.currentTime = 149
  music.tick()
  expect(music.state).toBe('blocked')
  audio.currentTime = 150
  music.tick()
  await vi.waitFor(() => expect(music.state).toBe('blocked'))
  expect(debug).toHaveBeenCalledOnce()
  music.dispose()
})
