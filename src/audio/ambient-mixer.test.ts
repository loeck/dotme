import { afterEach, expect, it, vi } from 'vitest'

import { required } from '../invariant'
import { AUDIO_LAYERS, AmbientMixer } from './ambient-mixer'
import type { AmbientMixerOptions, AudioFormat, AudioSample } from './ambient-mixer'
import { THUNDER_RATE } from './thunder'

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
  setValueCurveAtTime(values: Float32Array, at: number, duration: number) {
    this.events.push([values[0] ?? 0, at], [values.at(-1) ?? 0, at + duration])
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
  playbackRate = new Param()
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
function fixture(format?: AudioFormat, options: AmbientMixerOptions = { wide: false }) {
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
    decodeAudioData: async (_data: ArrayBuffer): Promise<AudioSample> => {
      const duration = decoded++ === 0 ? 60 : 16
      const sample = { duration, length: duration * 32000, numberOfChannels: 1 }
      samples.push(sample)
      return sample
    },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, signal: init?.signal })
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
    mixer: new AmbientMixer(context, format, options),
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
  for (const gain of gains.slice(1 + AUDIO_LAYERS.length))
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
  expect(requests).toHaveLength(AUDIO_LAYERS.length)
  expect(panners).toHaveLength(0)
  mixer.setEnvironment({ ...quietEnvironment, waterfall: { intensity: 1, pan: -0.65 } })
  await vi.waitFor(() => expect(samples).toHaveLength(AUDIO_LAYERS.length + 1))
  const sample = required(samples[AUDIO_LAYERS.length])
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

it('spreads each bed over two decorrelated passages, places calls and keeps owls to the night', async () => {
  vi.useFakeTimers()
  const { context, voices, panners, mixer } = fixture('mp3', {})
  mixer.setEnvironment({ solarHour: 12, daylight: 1, windSpeed: 3, rainIntensity: 0 })
  await mixer.load()
  mixer.resume()
  // Two passages per bed, each through its own panner on opposite sides.
  expect(voices).toHaveLength(8)
  // The first panner places the whole wind bed; each passage then has its own.
  expect(panners.slice(1).map((panner) => panner.pan.value)).toEqual([
    -0.65, 0.65, -0.65, 0.65, -0.65, 0.65, -0.65, 0.65,
  ])
  const water = voices.slice(0, 2)
  expect(required(water[0]).buffer).toBe(required(water[1]).buffer)
  for (let i = 0; i < 480; i++) {
    context.currentTime += 0.25
    vi.advanceTimersByTime(250)
  }
  // Birds sing by day with varied pitch; no owl calls in daylight.
  const rates = voices.map((voice) => voice.playbackRate.value).filter((rate) => rate !== 0)
  expect(rates.length).toBeGreaterThan(2)
  expect(rates.every((rate) => rate >= 0.96 && rate <= 1.04)).toBe(true)
  const dayCount = voices.length
  const owlStarts = () => voices.slice(dayCount).filter((voice) => voice.playbackRate.value === 0)
  mixer.setEnvironment({ solarHour: 1, daylight: 0, windSpeed: 0, rainIntensity: 0 })
  for (let i = 0; i < 1200; i++) {
    context.currentTime += 0.25
    vi.advanceTimersByTime(250)
  }
  // At night, the only short unpitched voices are owl windows (bed passages last over 8 s).
  const calls = owlStarts().filter((voice) => voice.end - voice.at < 8)
  expect(calls.length).toBeGreaterThan(1)
  expect(calls.every((voice) => voice.offset + voice.end - voice.at <= 16)).toBe(true)
  mixer.dispose()
})

it('rings a placed, tuned note for each stone touchdown, only while playing', async () => {
  const { context, panners, mixer } = fixture()
  class Oscillator extends Node {
    frequency = new Param()
    at = -1
    end = -1
    ended: (() => void) | undefined
    start(at: number) {
      this.at = at
    }
    stop(at: number) {
      this.end = at
    }
    addEventListener(_: 'ended', listener: () => void) {
      this.ended = listener
    }
  }
  const oscillators: Oscillator[] = []
  const withOscillators = Object.assign(context, {
    createOscillator: () => {
      const oscillator = new Oscillator()
      oscillators.push(oscillator)
      return oscillator
    },
  })
  const playing = new AmbientMixer(withOscillators, 'mp3', { wide: false })
  const touchdown = { index: 2, sinking: false, intensity: 0.8, pan: 0.4 }
  playing.skipNote(touchdown)
  expect(oscillators).toHaveLength(0)
  playing.setEnvironment({ solarHour: 12, daylight: 1, windSpeed: 2, rainIntensity: 0 })
  await playing.load()
  playing.resume()
  playing.skipNote(touchdown)
  // E5 by day, with its octave and twelfth, struck now and rung out within a few seconds.
  expect(oscillators.map((o) => Math.round(o.frequency.value))).toEqual([659, 1319, 1978])
  for (const oscillator of oscillators) {
    expect(oscillator.at).toBe(context.currentTime)
    expect(oscillator.end).toBeGreaterThan(context.currentTime + 1)
    expect(oscillator.end).toBeLessThan(context.currentTime + 4)
  }
  expect(required(panners.at(-1)).pan.value).toBe(0.4)
  // Silent or distant touchdowns play nothing; a mixer without oscillators ignores notes.
  playing.skipNote({ ...touchdown, intensity: 0 })
  expect(oscillators).toHaveLength(3)
  for (const oscillator of oscillators) oscillator.ended?.()
  expect(required(panners.at(-1)).disconnect).toHaveBeenCalled()
  expect(() => mixer.skipNote(touchdown)).not.toThrow()
})

it('rolls thunder in after a strike, at the speed of sound, only while playing', async () => {
  const { context, voices, panners, mixer } = fixture()
  const buffers: Array<{ length: number; rate: number; data: Float32Array | null }> = []
  const stormy = Object.assign(context, {
    sampleRate: 32_000,
    createBuffer: (channels: number, length: number, rate: number) => {
      const record: { length: number; rate: number; data: Float32Array | null } = {
        length,
        rate,
        data: null,
      }
      buffers.push(record)
      return {
        duration: length / rate,
        length,
        numberOfChannels: channels,
        copyToChannel: (source: Float32Array) => {
          record.data = source
        },
      }
    },
  })
  const playing = new AmbientMixer(stormy, 'mp3', { wide: false })
  const strike = { distance: 2000, delay: 2000 / 343, intensity: 0.8, pan: -0.3 }
  playing.thunder(strike)
  expect(buffers).toHaveLength(0)
  await playing.load()
  playing.resume()
  const before = voices.length
  playing.thunder(strike)
  expect(buffers).toHaveLength(1)
  const peal = required(voices.at(-1))
  expect(voices.length).toBe(before + 1)
  expect(peal.at).toBeCloseTo(context.currentTime + strike.delay, 9)
  expect(required(panners.at(-1)).pan.value).toBe(-0.3)
  expect(required(buffers[0]).rate).toBe(THUNDER_RATE)
  // A strike too faint to hear renders nothing; a mixer without buffers ignores storms.
  playing.thunder({ ...strike, intensity: 0 })
  expect(buffers).toHaveLength(1)
  expect(() => mixer.thunder(strike)).not.toThrow()
})

class Filter extends Node {
  type = 'lowpass'
  frequency = new Param()
  Q = new Param()
}
class Convolver extends Node {
  buffer: AudioSample | null = null
  normalize = false
}
/** The optional nodes a real context has: filters, a convolver and buffers. */
function complete(context: ReturnType<typeof fixture>['context']) {
  const filters: Filter[] = [],
    convolvers: Convolver[] = [],
    buffers: Array<{ channels: number; length: number; rate: number }> = []
  const full = Object.assign(context, {
    sampleRate: 32_000,
    createBiquadFilter: () => {
      const filter = new Filter()
      filters.push(filter)
      return filter
    },
    createConvolver: () => {
      const convolver = new Convolver()
      convolvers.push(convolver)
      return convolver
    },
    createBuffer: (channels: number, length: number, rate: number) => {
      buffers.push({ channels, length, rate })
      return { duration: length / rate, length, numberOfChannels: channels, copyToChannel() {} }
    },
  })
  return { full, filters, convolvers, buffers }
}
const lastTarget = (param: Param) => required(required(param.events.at(-1))[0])

it('fades the master without cancelAndHoldAtTime, as in Firefox', async () => {
  vi.useFakeTimers()
  const { context, gains, mixer } = fixture()
  // Firefox's AudioParam: no cancelAndHoldAtTime, but cancelScheduledValues and the rest.
  const params = gains.map((gain) => gain.gain)
  for (const param of params) Object.assign(param, { cancelAndHoldAtTime: undefined })
  const cancelled = vi.spyOn(required(params[0]), 'cancelScheduledValues')
  await mixer.load()
  expect(() => mixer.resume()).not.toThrow()
  const master = required(gains[0]).gain
  expect(cancelled).toHaveBeenCalledWith(0)
  // Held at its current value, then ramped up to the master level.
  expect(master.events.slice(-2)).toEqual([
    [0, 0],
    [0.76, 1.5],
  ])
  context.currentTime = 3
  mixer.pause()
  expect(master.events.slice(-2)).toEqual([
    [0.76, 3],
    [0, 3.04],
  ])
  // Interrupted half-way, a fade starts from where the previous one had got to, even though
  // the parameter's reported value is stale.
  context.currentTime = 10
  mixer.resume()
  context.currentTime = 10.75
  mixer.pause()
  expect(required(master.events.at(-2))[0]).toBeCloseTo(0.38)
  expect(required(master.events.at(-2))[1]).toBe(10.75)
  mixer.dispose()
})

class Compressor extends Node {
  threshold = new Param()
  knee = new Param()
  ratio = new Param()
  attack = new Param()
  release = new Param()
}

it('limits the louder master before the output, without changing the balance', async () => {
  const { context, gains, mixer } = fixture()
  const limiters: Compressor[] = []
  const limited = Object.assign(context, {
    createDynamicsCompressor: () => {
      const limiter = new Compressor()
      limiters.push(limiter)
      return limiter
    },
  })
  const graph = new AmbientMixer(limited, 'mp3', { wide: false })
  expect(limiters).toHaveLength(1)
  const limiter = required(limiters[0])
  // Master, limiter, destination: a peak limiter well above the beds, not a compressor.
  expect(limiter.connections).toEqual([context.destination])
  const master = required(gains.find((gain) => gain.connections.includes(limiter)))
  expect(limiter.threshold.value).toBe(-6)
  expect(limiter.ratio.value).toBeGreaterThanOrEqual(8)
  expect(limiter.attack.value).toBeLessThan(0.01)
  await graph.load()
  graph.resume()
  expect(lastTarget(master.gain)).toBe(0.76)
  graph.dispose()
  expect(limiter.disconnect).toHaveBeenCalled()
  mixer.dispose()
})

it('holds with cancelAndHoldAtTime where the browser has it', async () => {
  const { context, gains, mixer } = fixture()
  const hold = vi.spyOn(required(gains[0]).gain, 'cancelAndHoldAtTime')
  const cancel = vi.spyOn(required(gains[0]).gain, 'cancelScheduledValues')
  await mixer.load()
  context.currentTime = 2
  mixer.resume()
  expect(hold).toHaveBeenCalledWith(2)
  expect(cancel).not.toHaveBeenCalled()
  mixer.dispose()
})

it('admits clips in layer order, whatever order they decode in, and always keeps the water', async () => {
  const sizes: Record<string, number> = {
    water: 60,
    wind: 23,
    rain: 21,
    insects: 17,
    birds: 20,
    owls: 14,
    splashes: 8,
  }
  const keptWith = async (order: readonly string[]) => {
    const { context, mixer, voices } = fixture()
    // Seconds of 32 kHz stereo; 24 MiB holds about 98 s of it, so the last layers cannot fit.
    let pending: Array<() => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(url).buffer,
      })),
    )
    context.decodeAudioData = (data: ArrayBuffer) =>
      new Promise<AudioSample>((resolve) => {
        const layer = required(/\/audio\/(\w+)\./.exec(new TextDecoder().decode(data))?.[1])
        const duration = required(sizes[layer])
        pending.push(() => resolve({ duration, length: duration * 32000, numberOfChannels: 2 }))
        Object.assign(pending, { [layer]: pending.at(-1) })
      })
    const loading = mixer.load()
    await vi.waitFor(() => expect(pending).toHaveLength(order.length))
    const byLayer = new Map(Object.entries(pending).filter(([key]) => key in sizes))
    for (const layer of order) required(byLayer.get(layer))()
    pending = []
    await loading
    mixer.setEnvironment({ solarHour: 12, daylight: 1, windSpeed: 3, rainIntensity: 0.5 })
    mixer.resume()
    const durations = new Set(voices.map((voice) => voice.buffer?.duration ?? 0))
    mixer.dispose()
    return [...durations].toSorted((a, b) => a - b)
  }
  const forwards = await keptWith(AUDIO_LAYERS)
  const backwards = await keptWith(AUDIO_LAYERS.toReversed())
  expect(backwards).toEqual(forwards)
  expect(forwards).toContain(60)
})

it('opens the rain filter with intensity, damps fog and snow, and silences rain under snow', async () => {
  const { context, gains, mixer } = fixture()
  const { full, filters } = complete(context)
  const graph = new AmbientMixer(full, 'mp3', { wide: false })
  await graph.load()
  const [shelf, rain] = filters
  expect(required(shelf).type).toBe('highshelf')
  expect(required(rain).type).toBe('lowpass')
  const at = { solarHour: 12, daylight: 1, windSpeed: 2, rainIntensity: 0.1 }
  graph.setEnvironment(at)
  const drizzle = lastTarget(required(rain).frequency)
  graph.setEnvironment({ ...at, rainIntensity: 1 })
  expect(lastTarget(required(rain).frequency)).toBeGreaterThan(drizzle * 4)
  expect(lastTarget(required(shelf).gain)).toBe(-0)
  // Layer gains of this mixer come after the first fixture mixer's master and layers.
  const layers = gains.slice(gains.length - AUDIO_LAYERS.length - 3, gains.length - 3)
  const layer = (name: (typeof AUDIO_LAYERS)[number]) =>
    required(layers[AUDIO_LAYERS.indexOf(name)]).gain
  graph.setEnvironment({ ...at, rainIntensity: 1, fog: 1 })
  expect(lastTarget(required(shelf).gain)).toBe(-14)
  const clearBirds = (() => {
    graph.setEnvironment(at)
    return lastTarget(layer('birds'))
  })()
  graph.setEnvironment({ ...at, fog: 1 })
  expect(lastTarget(layer('birds'))).toBeCloseTo(clearBirds * 0.4)
  graph.setEnvironment({ ...at, rainIntensity: 1, snow: 1 })
  expect(lastTarget(layer('rain'))).toBe(0)
  graph.dispose()
  mixer.dispose()
})

it('builds one stereo reverb within the budget, wetter at night, and pre-renders thunder at idle', async () => {
  vi.useFakeTimers()
  const { context, gains, mixer } = fixture()
  const { full, convolvers, buffers } = complete(context)
  const graph = new AmbientMixer(full, 'mp3', { wide: false })
  const day = { solarHour: 12, daylight: 1, windSpeed: 2, rainIntensity: 0 }
  graph.setEnvironment(day)
  await graph.load()
  expect(convolvers).toHaveLength(1)
  expect(required(convolvers[0]).buffer).toMatchObject({ numberOfChannels: 2, length: 80_000 })
  expect(buffers).toEqual([{ channels: 2, length: 80_000, rate: 32_000 }])
  // The reverb return is the last gain the mixer made before its owls send.
  const wet = required(gains.at(-2)).gain
  const dayWet = lastTarget(wet)
  graph.setEnvironment({ ...day, daylight: 0, solarHour: 0 })
  expect(lastTarget(wet)).toBeGreaterThan(dayWet)
  // Thunder peals render one per idle period, at 8 kHz.
  await vi.advanceTimersByTimeAsync(1000)
  expect(buffers.slice(1)).toEqual([
    { channels: 1, length: 40_000, rate: THUNDER_RATE },
    { channels: 1, length: 40_000, rate: THUNDER_RATE },
    { channels: 1, length: 40_000, rate: THUNDER_RATE },
  ])
  graph.dispose()
  mixer.dispose()
})

it('speeds crickets up in the warm, silences them in the cold and pans the wind upwind', async () => {
  vi.useFakeTimers()
  const { voices, panners, mixer } = fixture('mp3', {})
  const night = { solarHour: 1, daylight: 0, windSpeed: 6, rainIntensity: 0 }
  mixer.setEnvironment({ ...night, temperature: 28, windPan: 1 })
  await mixer.load()
  mixer.resume()
  const insects = voices.filter((voice) => voice.playbackRate.value > 1)
  expect(insects).toHaveLength(2)
  for (const voice of insects) {
    expect(voice.playbackRate.value).toBeCloseTo(1.096)
    // A faster passage still ends inside the recording.
    expect(voice.offset + (voice.end - voice.at) * voice.playbackRate.value).toBeLessThanOrEqual(
      16.001,
    )
  }
  expect(lastTarget(required(panners[0]).pan)).toBeCloseTo(0.6)
  mixer.setEnvironment({ ...night, temperature: 4 })
  expect(lastTarget(required(panners[0]).pan)).toBe(0)
  mixer.dispose()
})

it('rumbles a distant storm on its own under reduced motion only', async () => {
  vi.useFakeTimers()
  const { context, voices, mixer } = fixture()
  const { full } = complete(context)
  const graph = new AmbientMixer(full, 'mp3', { wide: false })
  const storm = { solarHour: 12, daylight: 1, windSpeed: 2, rainIntensity: 0.4, storm: true }
  graph.setEnvironment(storm)
  await graph.load()
  graph.resume()
  const peals = () => voices.filter((voice) => (voice.buffer?.duration ?? 0) === 5).length
  for (let i = 0; i < 400; i++) {
    context.currentTime += 0.25
    vi.advanceTimersByTime(250)
  }
  expect(peals()).toBe(0)
  graph.setEnvironment({ ...storm, reducedMotion: true })
  for (let i = 0; i < 400; i++) {
    context.currentTime += 0.25
    vi.advanceTimersByTime(250)
  }
  expect(peals()).toBeGreaterThanOrEqual(2)
  expect(peals()).toBeLessThanOrEqual(6)
  graph.setEnvironment({ ...storm, storm: false, reducedMotion: true })
  const count = peals()
  for (let i = 0; i < 400; i++) {
    context.currentTime += 0.25
    vi.advanceTimersByTime(250)
  }
  expect(peals()).toBe(count)
  graph.dispose()
  mixer.dispose()
})
