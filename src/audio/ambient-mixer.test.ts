import { afterEach, expect, it, vi } from 'vitest'

import { AmbientMixer } from './ambient-mixer'

class Param {
  value = 0
  events: number[][] = []
  cancelAndHoldAtTime() {}
  cancelScheduledValues() {}
  setValueAtTime(value: number, at: number) {
    this.events.push([value, at])
    return this
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.events.push([value, at])
    return this
  }
  setTargetAtTime(value: number, at: number) {
    this.events.push([value, at])
    return this
  }
}
class Node {
  gain = new Param()
  connect() {}
  disconnect = vi.fn<() => void>()
}
class Source extends Node {
  buffer: AudioBuffer | null = null
  at = -1
  end = -1
  offset = 0
  start(at: number, offset = 0) {
    this.offset = offset
    this.at = at
  }
  stop(at: number) {
    this.end = at
  }
  addEventListener() {}
}
function fixture() {
  const voices: Source[] = [],
    gains: Node[] = []
  let decoded = 0
  const context = {
    currentTime: 0,
    state: 'running',
    destination: new Node(),
    createGain: () => {
      const gain = new Node()
      gains.push(gain)
      return gain
    },
    createBufferSource: () => {
      const source = new Source()
      voices.push(source)
      return source
    },
    decodeAudioData: async () => {
      const duration = decoded++ === 0 ? 60 : 19
      return { duration, length: duration * 32000, numberOfChannels: 1 }
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })),
  )
  return { context, voices, gains, mixer: new AmbientMixer(context as unknown as AudioContext) }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('schedules three minutes with overlap, bounded envelopes, spaced birds and no hidden catch-up', async () => {
  vi.useFakeTimers()
  const { context, voices, gains, mixer } = fixture()
  mixer.setEnvironment({ solarHour: 12, daylight: 1, windSpeed: 12, rainIntensity: 0 })
  await mixer.load()
  mixer.resume()
  for (let i = 0; i < 720; i++) {
    context.currentTime += 0.25
    vi.advanceTimersByTime(250)
  }
  expect(voices.length).toBeGreaterThan(40)
  const water = voices.filter((v) => v.buffer === voices[0]!.buffer)
  for (let i = 1; i < water.length; i++) expect(water[i]!.at).toBeCloseTo(water[i - 1]!.end - 4)
  for (let i = 1; i < water.length; i++) {
    expect(Math.abs(water[i]!.offset - water[i - 1]!.offset)).toBeGreaterThanOrEqual(8)
    expect(water[i]!.offset + water[i]!.end - water[i]!.at).toBeLessThanOrEqual(60.001)
  }
  for (const gain of gains.slice(6))
    for (const event of gain.gain.events) expect(event[0]).toBeGreaterThanOrEqual(0)
  const count = voices.length
  mixer.pause()
  context.state = 'suspended'
  vi.advanceTimersByTime(180000)
  expect(voices).toHaveLength(count)
  context.state = 'running'
  mixer.resume()
  expect(voices.length - count).toBeLessThanOrEqual(4)
  mixer.dispose(0.3)
  expect(voices.every((v) => v.end === context.currentTime + 0.3)).toBe(true)
  vi.advanceTimersByTime(400)
  expect(gains[0]!.disconnect).toHaveBeenCalled()
})

it('cannot play during a pending load or after cancellation, even if decoding finishes late', async () => {
  const { context, voices, mixer } = fixture()
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  context.decodeAudioData = async () => {
    await pending
    return { duration: 19, length: 19 * 32000, numberOfChannels: 1 }
  }
  const loading = mixer.load()
  mixer.resume()
  expect(voices).toHaveLength(0)
  await Promise.resolve()
  mixer.dispose()
  finish!()
  await loading
  mixer.resume()
  expect(voices).toHaveLength(0)
})

it('accepts missing secondary layers and rejects missing base water', async () => {
  const { mixer } = fixture()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.includes('water')) throw new Error('offline')
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }
    }),
  )
  await expect(mixer.load()).resolves.toBeUndefined()
  mixer.dispose()
  const { mixer: failed } = fixture()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline')
    }),
  )
  await expect(failed.load()).rejects.toThrow('Water audio unavailable')
  failed.dispose()
})
