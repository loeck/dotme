import { afterEach, expect, it, vi } from 'vitest'

import { required } from '../invariant'
import { AUDIO_LAYERS, AmbientMixer } from './ambient-mixer'
import type { AudioFormat, AudioSample } from './ambient-mixer'

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
  setTargetAtTime(value: number, at: number, constant: number) {
    this.events.push([value, at, constant])
    return this
  }
}
class Node {
  gain = new Param()
  connections: unknown[] = []
  connect(destination: unknown) {
    this.connections.push(destination)
  }
  disconnect = vi.fn<() => void>()
}
class Panner extends Node {
  pan = new Param()
}
class Source extends Node {
  buffer: AudioSample | null = null
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
function fixture(format?: AudioFormat) {
  const voices: Source[] = [],
    gains: Node[] = [],
    panners: Panner[] = [],
    samples: AudioSample[] = [],
    requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = []
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
    createStereoPanner: () => {
      const panner = new Panner()
      panners.push(panner)
      return panner
    },
    decodeAudioData: async () => {
      const duration = decoded++ === 0 ? 60 : 19
      const sample = { duration, length: duration * 32000, numberOfChannels: 1 }
      samples.push(sample)
      return sample
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      requests.push({ url, signal: options?.signal })
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }
    }),
  )
  return {
    context,
    voices,
    gains,
    panners,
    samples,
    requests,
    mixer: new AmbientMixer(context, format),
  }
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
  const water = voices.filter((v) => v.buffer === required(voices[0]).buffer)
  for (let i = 1; i < water.length; i++)
    expect(required(water[i]).at).toBeCloseTo(required(water[i - 1]).end - 4)
  for (let i = 1; i < water.length; i++) {
    expect(
      Math.abs(required(water[i]).offset - required(water[i - 1]).offset),
    ).toBeGreaterThanOrEqual(8)
    expect(
      required(water[i]).offset + required(water[i]).end - required(water[i]).at,
    ).toBeLessThanOrEqual(60.001)
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
  expect(required(gains[0]).disconnect).toHaveBeenCalled()
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
  required(finish)()
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

it('requests every layer in the selected format', async () => {
  const { mixer, requests } = fixture('ogg')
  await mixer.load()
  expect(requests.map((request) => request.url)).toEqual(
    AUDIO_LAYERS.map((layer) => `/audio/${layer}.ogg`),
  )
  mixer.dispose()
})

it('falls back to MP3 after an Ogg clip fails', async () => {
  const { mixer } = fixture('ogg')
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      return {
        ok: url !== '/audio/water.ogg',
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    }),
  )
  await mixer.load()
  expect(urls).toContain('/audio/water.mp3')
  expect(urls.filter((url) => url.endsWith('.ogg'))).toHaveLength(AUDIO_LAYERS.length)
  mixer.dispose()
})

const quietEnvironment = { solarHour: 0, daylight: 0, windSpeed: 0, rainIntensity: 0 }

it('loads waterfall only when present, smooths its pan and stops scheduling it when absent', async () => {
  vi.useFakeTimers()
  const { context, mixer, requests, panners, gains, samples, voices } = fixture()
  mixer.setEnvironment(quietEnvironment)
  await mixer.load()
  mixer.resume()
  expect(requests).toHaveLength(5)
  expect(panners).toHaveLength(0)
  mixer.setEnvironment({ ...quietEnvironment, waterfall: { intensity: 1, pan: -0.65 } })
  await vi.waitFor(() => expect(samples).toHaveLength(6))
  const sample = required(samples[5])
  await vi.waitFor(() => expect(voices.some((voice) => voice.buffer === sample)).toBe(true))
  const panner = required(panners[0])
  expect(panner.connections).toEqual([gains[0]])
  expect(panner.pan.events.at(-1)).toEqual([-0.65, 0, 2])
  context.currentTime = 2
  mixer.setEnvironment({ ...quietEnvironment, waterfall: { intensity: 1, pan: 0.3 } })
  expect(panner.pan.events.at(-1)).toEqual([0.3, 2, 2])
  expect(requests.filter((request) => request.url === '/audio/waterfall.mp3')).toHaveLength(1)
  const count = voices.filter((voice) => voice.buffer === sample).length
  mixer.setEnvironment(quietEnvironment)
  context.currentTime = 100
  vi.advanceTimersByTime(250)
  expect(voices.filter((voice) => voice.buffer === sample)).toHaveLength(count)
  mixer.dispose()
  expect(panner.disconnect).toHaveBeenCalledTimes(1)
})

it('keeps base ambience available while an optional waterfall request is pending or fails', async () => {
  vi.useFakeTimers()
  const { mixer, voices, gains, panners } = fixture()
  let rejectWaterfall: ((reason: Error) => void) | undefined
  const optional = new Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>(
    (_resolve, reject) => {
      rejectWaterfall = reject
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/audio/waterfall.mp3') return optional
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }
    }),
  )
  mixer.setEnvironment({ ...quietEnvironment, waterfall: { intensity: 1, pan: -0.5 } })
  await mixer.load()
  mixer.resume()
  expect(voices).toHaveLength(4)
  expect(panners).toHaveLength(0)
  expect(required(gains[1]).gain.events.at(-1)).toEqual([0.14, 0, 2])
  required(rejectWaterfall)(new Error('Waterfall unavailable'))
  await optional.catch(() => {})
  expect(panners).toHaveLength(0)
  expect(required(gains[1]).gain.events.at(-1)).toEqual([0.14, 0, 2])
  mixer.pause()
  mixer.resume()
  expect(voices).toHaveLength(4)
  mixer.dispose()
})

it('cancels a lazy waterfall load and cannot start late decoded audio after disposal', async () => {
  const { context, mixer, requests, voices, panners } = fixture()
  await mixer.load()
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const decode = vi.fn<() => Promise<AudioSample>>(async () => {
    await pending
    return { duration: 30, length: 30 * 32000, numberOfChannels: 1 }
  })
  context.decodeAudioData = decode
  mixer.setEnvironment({ ...quietEnvironment, waterfall: { intensity: 1, pan: -0.5 } })
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
  const request = requests.find((item) => item.url === '/audio/waterfall.mp3')
  mixer.dispose()
  expect(required(request).signal?.aborted).toBe(true)
  required(finish)()
  await pending
  await Promise.resolve()
  mixer.resume()
  expect(voices).toHaveLength(0)
  expect(panners).toHaveLength(0)
})

it('does not start a newly decoded waterfall while playback is paused', async () => {
  vi.useFakeTimers()
  const { context, mixer, voices } = fixture()
  await mixer.load()
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const decode = vi.fn<() => Promise<AudioSample>>(async () => {
    await pending
    return { duration: 23, length: 23 * 32000, numberOfChannels: 1 }
  })
  context.decodeAudioData = decode
  mixer.resume()
  mixer.setEnvironment({ ...quietEnvironment, waterfall: { intensity: 1, pan: -0.5 } })
  await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1))
  mixer.pause()
  required(finish)()
  await vi.advanceTimersByTimeAsync(0)
  expect(voices).toHaveLength(4)
  mixer.resume()
  expect(voices).toHaveLength(5)
  mixer.dispose()
})

it('rejects an oversized optional recording without allocating its branch or weakening base water', async () => {
  vi.useFakeTimers()
  const { context, mixer, voices, gains, panners } = fixture()
  mixer.setEnvironment(quietEnvironment)
  await mixer.load()
  mixer.resume()
  const decode = vi.fn<() => Promise<AudioSample>>(async () => ({
    duration: 300,
    length: 300 * 32000,
    numberOfChannels: 1,
  }))
  context.decodeAudioData = decode
  mixer.setEnvironment({ ...quietEnvironment, waterfall: { intensity: 1, pan: -0.5 } })
  await vi.advanceTimersByTimeAsync(0)
  expect(decode).toHaveBeenCalledOnce()
  expect(panners).toHaveLength(0)
  expect(voices).toHaveLength(4)
  expect(required(gains[1]).gain.events.at(-1)).toEqual([0.14, 0, 2])
  mixer.dispose()
})

it('registers a decoded waterfall atomically when playback resumes between load microtasks', async () => {
  vi.useFakeTimers()
  const { context, mixer, voices, panners } = fixture()
  await mixer.load()
  const sample = { duration: 23, length: 23 * 32000, numberOfChannels: 1 }
  let observeResume: (() => void) | undefined
  const resumed = new Promise<void>((resolve, reject) => {
    observeResume = () => {
      try {
        mixer.resume()
        resolve()
      } catch (error) {
        reject(error)
      }
    }
  })
  context.decodeAudioData = async () => {
    // Run after the decoder's consumer, before its completion callback.
    queueMicrotask(() => queueMicrotask(required(observeResume)))
    return sample
  }
  mixer.setEnvironment({ ...quietEnvironment, waterfall: { intensity: 1, pan: -0.5 } })
  try {
    await expect(resumed).resolves.toBeUndefined()
    await vi.waitFor(() =>
      expect(voices.filter((voice) => voice.buffer === sample)).toHaveLength(1),
    )
    expect(panners).toHaveLength(1)
  } finally {
    mixer.dispose()
  }
})
