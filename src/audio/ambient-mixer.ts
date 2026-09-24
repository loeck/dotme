import { required } from '../invariant'
import { ambientMix } from './environment'
import type { AmbientEnvironment } from './environment'
import { waterPhrase } from './water-phrases'

export const AUDIO_LAYERS = ['water', 'wind', 'rain', 'insects', 'birds'] as const
type Layer = (typeof AUDIO_LAYERS)[number] | 'waterfall'
const CROSSFADE = 1.5

export interface AudioSample {
  readonly duration: number
  readonly length: number
  readonly numberOfChannels: number
}
interface MixerNode {
  connect(destination: MixerNode): unknown
  disconnect(): void
}
interface MixerParam {
  value: number
  cancelAndHoldAtTime(time: number): unknown
  setTargetAtTime(value: number, time: number, constant: number): unknown
  setValueAtTime(value: number, time: number): unknown
  linearRampToValueAtTime(value: number, time: number): unknown
}
interface MixerGain extends MixerNode {
  readonly gain: MixerParam
}
interface MixerPanner extends MixerNode {
  readonly pan: MixerParam
}
interface MixerSource extends MixerNode {
  buffer: AudioSample | null
  start(time: number, offset: number): void
  stop(time: number): void
  addEventListener(type: 'ended', listener: () => void, options: { once: boolean }): void
}
/** The mixer requires only these public audio operations; tests provide the same contract. */
export interface AmbientAudioContext {
  readonly currentTime: number
  readonly state: string
  readonly destination: MixerNode
  createGain(): MixerGain
  createStereoPanner(): MixerPanner
  createBufferSource(): MixerSource
  decodeAudioData(data: ArrayBuffer): Promise<AudioSample>
}

/** One context is owned by the sound control. Everything else loads on demand. */
export class AmbientMixer {
  private readonly master: MixerGain
  private readonly gains = new Map<Layer, MixerGain>()
  private readonly buffers = new Map<Layer, AudioSample>()
  private readonly voices = new Map<MixerSource, MixerGain>()
  private readonly next = new Map<Layer, number>()
  private readonly loading = new AbortController()
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private started = false
  private active = false
  private ready = false
  private waterfallRequested = false
  private waterfallPan: MixerPanner | undefined
  private nextBird = 0
  private waterOffset = -Infinity
  private decodedBytes = 0
  private environment: AmbientEnvironment = {
    solarHour: 0,
    daylight: 0,
    windSpeed: 0,
    rainIntensity: 0,
  }

  private readonly context: AmbientAudioContext

  constructor(context: AmbientAudioContext) {
    this.context = context
    this.master = context.createGain()
    this.master.gain.value = 0
    this.master.connect(context.destination)
    for (const layer of AUDIO_LAYERS) {
      const gain = context.createGain()
      gain.gain.value = 0
      gain.connect(this.master)
      this.gains.set(layer, gain)
    }
  }

  async load() {
    await Promise.allSettled(
      AUDIO_LAYERS.map(async (layer) => {
        const buffer = await this.loadLayer(layer)
        if (buffer && !this.disposed) this.buffers.set(layer, buffer)
      }),
    )
    if (this.disposed) return
    if (!this.buffers.has('water')) throw new Error('Water audio unavailable')
    this.ready = true
    this.loadWaterfall()
  }

  private async loadLayer(layer: Layer) {
    const response = await fetch(`/audio/${layer}.mp3`, {
      signal: AbortSignal.any([this.loading.signal, AbortSignal.timeout(15000)]),
    })
    if (!response.ok) throw new Error(`Audio ${layer}: ${response.status}`)
    const data = await response.arrayBuffer()
    if (this.disposed) return undefined
    const buffer = await this.context.decodeAudioData(data)
    if (this.disposed) return undefined
    const bytes = buffer.length * buffer.numberOfChannels * 4
    if (this.decodedBytes + bytes > 24 * 1024 * 1024)
      throw new Error('Audio memory budget exceeded')
    this.decodedBytes += bytes
    return buffer
  }

  private loadWaterfall() {
    if (
      this.disposed ||
      !this.ready ||
      this.waterfallRequested ||
      ambientMix(this.environment).waterfall <= 0
    )
      return
    this.waterfallRequested = true
    // This secondary asset never blocks the base ambience or restarts it on failure.
    void this.loadLayer('waterfall')
      .then((buffer) => {
        if (!buffer || this.disposed) return undefined
        const gain = this.context.createGain()
        gain.gain.value = 0
        this.waterfallPan = this.context.createStereoPanner()
        gain.connect(this.waterfallPan)
        this.waterfallPan.connect(this.master)
        this.gains.set('waterfall', gain)
        // Publish the recording only once its complete playback branch exists.
        this.buffers.set('waterfall', buffer)
        this.updateMix()
        this.schedule()
        return undefined
      })
      .catch(() => {})
  }

  setEnvironment(environment: AmbientEnvironment) {
    if (this.disposed) return
    this.environment = environment
    this.updateMix()
    this.loadWaterfall()
  }

  private updateMix() {
    // An unavailable secondary recording must not attenuate the base water.
    const mix = ambientMix(
      this.buffers.has('waterfall')
        ? this.environment
        : { ...this.environment, waterfall: { intensity: 0, pan: 0 } },
    )
    const now = this.context.currentTime
    for (const [layer, gain] of this.gains) {
      gain.gain.cancelAndHoldAtTime(now)
      gain.gain.setTargetAtTime(mix[layer], now, 2)
    }
    if (this.waterfallPan) {
      const pan = this.environment.waterfall?.pan ?? 0
      this.waterfallPan.pan.cancelAndHoldAtTime(now)
      this.waterfallPan.pan.setTargetAtTime(
        Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0,
        now,
        2,
      )
    }
  }

  private voice(layer: Layer, at: number, duration: number, offset = 0, crossfade = CROSSFADE) {
    const buffer = this.buffers.get(layer)
    if (!buffer || this.disposed) return
    const source = this.context.createBufferSource(),
      envelope = this.context.createGain()
    source.buffer = buffer
    source.connect(envelope)
    envelope.connect(required(this.gains.get(layer)))
    const fade = Math.min(crossfade, duration / 3)
    envelope.gain.setValueAtTime(0, at)
    envelope.gain.linearRampToValueAtTime(1, at + fade)
    envelope.gain.setValueAtTime(1, at + duration - fade)
    envelope.gain.linearRampToValueAtTime(0, at + duration)
    this.voices.set(source, envelope)
    source.addEventListener(
      'ended',
      () => {
        source.disconnect()
        envelope.disconnect()
        this.voices.delete(source)
      },
      { once: true },
    )
    source.start(at, offset)
    source.stop(at + duration)
  }

  private schedule = () => {
    if (this.disposed || !this.active || this.context.state !== 'running') return
    const now = this.context.currentTime
    for (const [layer, buffer] of this.buffers) {
      if (layer === 'birds') continue
      if (layer === 'waterfall' && ambientMix(this.environment).waterfall <= 0) continue
      const next = this.next.get(layer) ?? now
      if (next > now + 0.75) continue
      const at = Math.max(now, next)
      const phrase =
        layer === 'water'
          ? waterPhrase(buffer.duration, this.waterOffset)
          : { offset: 0, duration: buffer.duration, fade: layer === 'waterfall' ? 3 : CROSSFADE }
      if (layer === 'water') this.waterOffset = phrase.offset
      this.voice(layer, at, phrase.duration, phrase.offset, phrase.fade)
      this.next.set(layer, at + phrase.duration - phrase.fade)
    }
    if (now >= this.nextBird) {
      this.nextBird = now + 20 + Math.random() * 40
      if (this.environment.daylight > 0.5 && this.environment.rainIntensity < 0.7) {
        const bird = this.buffers.get('birds')
        if (bird) this.voice('birds', now, bird.duration)
      }
    }
  }

  resume() {
    if (this.disposed || !this.ready) return
    this.active = true
    const now = this.context.currentTime
    if (!this.started) {
      this.nextBird = now + 20 + Math.random() * 40
      this.started = true
    }
    this.master.gain.cancelAndHoldAtTime(now)
    this.master.gain.linearRampToValueAtTime(0.38, now + 1.5)
    this.schedule()
    clearInterval(this.timer)
    this.timer = setInterval(this.schedule, 250)
  }

  pause() {
    this.active = false
    clearInterval(this.timer)
    this.timer = undefined
    this.master.gain.cancelAndHoldAtTime(this.context.currentTime)
    this.master.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.04)
  }

  dispose(fade = 0) {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.loading.abort()
    clearInterval(this.timer)
    const now = this.context.currentTime
    this.master.gain.cancelAndHoldAtTime(now)
    this.master.gain.linearRampToValueAtTime(0, now + fade)
    for (const source of this.voices.keys()) source.stop(now + fade)
    this.buffers.clear()
    const disconnect = () => {
      for (const [source, gain] of this.voices) {
        source.disconnect()
        gain.disconnect()
      }
      this.voices.clear()
      for (const gain of this.gains.values()) gain.disconnect()
      this.waterfallPan?.disconnect()
      this.master.disconnect()
    }
    if (fade) setTimeout(disconnect, fade * 1000 + 30)
    else disconnect()
  }
}
