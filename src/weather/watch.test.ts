// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { parisWeatherFixture } from './paris.fixture'
import { forcedSceneWeather } from './scene'
import type { SceneWeather } from './scene'
import { fakeAbortTimeouts, memoryStorage } from './timeouts.fixture'
import {
  nextWeatherSlotDelay,
  watchSceneWeather,
  WEATHER_RETRY_MS,
  WEATHER_SLOT_MS,
  WEATHER_SLOT_SETTLE_MS,
} from './watch'

const SLOT = 1790150400
const fetchMock = vi.fn<typeof fetch>()
/** Open-Meteo answers with the slot that contains the request time. */
function serveSlots(edit: (current: Record<string, number>) => void = () => {}) {
  fetchMock.mockImplementation(async () => {
    const data = parisWeatherFixture()
    data.current.time = Math.floor(Date.now() / 1000 / 900) * 900
    edit(data.current)
    return new Response(JSON.stringify(data))
  })
}
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}
/** The live weather the scene opened with: the fixture's slot, 10:00 in Paris. */
const opening = (): SceneWeather => ({
  ...forcedSceneWeather(42, 'clear'),
  source: 'live',
  nowSeconds: 36_000,
})

let controller: AbortController
beforeEach(() => {
  vi.useFakeTimers()
  fakeAbortTimeouts()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('localStorage', memoryStorage())
  // Ten minutes into the opening slot.
  vi.setSystemTime((SLOT + 600) * 1000)
  controller = new AbortController()
})
afterEach(() => {
  controller.abort()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})

it('waits for each slot to settle', () => {
  const start = SLOT * 1000
  expect(nextWeatherSlotDelay(start)).toBe(WEATHER_SLOT_SETTLE_MS)
  expect(nextWeatherSlotDelay(start + WEATHER_SLOT_SETTLE_MS)).toBe(WEATHER_SLOT_MS)
  expect(nextWeatherSlotDelay(start + 600_000)).toBe(WEATHER_SLOT_MS - 600_000 + 60_000)
})

it('reports each new slot once, a minute after it begins', async () => {
  serveSlots((current) => {
    current.temperature_2m = 10 + (current.time ?? 0) / 900 - SLOT / 900
  })
  const changes: SceneWeather[] = []
  watchSceneWeather({ current: opening() }, (weather) => changes.push(weather), controller.signal)
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(fetchMock).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ source: 'live', temperature: 11 })
  await vi.advanceTimersByTimeAsync(WEATHER_SLOT_MS)
  expect(changes.map((weather) => weather.temperature)).toEqual([11, 12])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('skips slots while hidden and catches up once on return', async () => {
  serveSlots()
  const onChange = vi.fn<(weather: SceneWeather) => void>()
  watchSceneWeather({ current: opening() }, onChange, controller.signal)
  setHidden(true)
  await vi.advanceTimersByTimeAsync(3 * WEATHER_SLOT_MS)
  expect(fetchMock).not.toHaveBeenCalled()
  setHidden(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledOnce()
  // Visible again: back on the slot schedule.
  setHidden(true)
  setHidden(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('retries soon after a failed preload and silently after failed refreshes', async () => {
  fetchMock.mockRejectedValue(new TypeError('offline'))
  const onChange = vi.fn<(weather: SceneWeather) => void>()
  watchSceneWeather({}, onChange, controller.signal)
  await vi.advanceTimersByTimeAsync(WEATHER_RETRY_MS)
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(onChange).not.toHaveBeenCalled()
  serveSlots()
  await vi.advanceTimersByTimeAsync(WEATHER_SLOT_MS)
  expect(onChange).toHaveBeenCalledOnce()
})

it('watches nothing for forced weather and stops when aborted', async () => {
  serveSlots()
  const onChange = vi.fn<(weather: SceneWeather) => void>()
  watchSceneWeather(
    { weather: 'fog', current: forcedSceneWeather(1, 'fog') },
    onChange,
    controller.signal,
  )
  await vi.advanceTimersByTimeAsync(2 * WEATHER_SLOT_MS)
  expect(fetchMock).not.toHaveBeenCalled()
  watchSceneWeather({}, onChange, controller.signal)
  controller.abort()
  await vi.advanceTimersByTimeAsync(2 * WEATHER_SLOT_MS)
  expect(fetchMock).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
