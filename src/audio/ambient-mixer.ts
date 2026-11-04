import { required } from '../invariant'
import { ambientMix, birdChorus } from './environment'
import type { AmbientEnvironment } from './environment'
import { AmbientMusic } from './music'
import { loopPhrase, pickPhrase, waterPhrase } from './water-phrases'
import { WaterSoundPicker } from './water-sounds'
import type { WaterSoundEvent } from './water-sounds'

export const AUDIO_LAYERS = [
  'water',
  'wind',
  'rain',
  'insects',
  'birds',
  'owls',
  'splashes',
] as const
type Layer = (typeof AUDIO_LAYERS)[number] | 'waterfall'
export type AudioFormat = 'ogg' | 'mp3'
const MASTER = 0.38
/** Fixed level of the splash takes; each event already carries its distance attenuation. */
const SPLASH_LEVEL = 0.3
/** Continuous beds; birds and owls are separate calls, and the waterfall is a point source. */
const BEDS = ['water', 'wind', 'rain', 'insects'] as const
/** Each bed plays two independent passages, one leaning to each side, for a wide field. */
const SIDES = [-0.65, 0.65] as const
/**
 * Call windows in owls.ogg, three generated groups of owl hoots transposed down to a tawny
 * owl's register. [offset, duration] in seconds.
 */
const OWL_CALLS: ReadonlyArray<readonly [number, number]> = [
  [0, 5],
  [5, 5],
  [10, 3.6],
]
/** Equal-power fade curves: uncorrelated passages keep a constant loudness while overlapping. */
const FADE_IN = Float32Array.from({ length: 32 }, (_, i) => Math.sin((i / 31) * (Math.PI / 2)))
const FADE_OUT = FADE_IN.toReversed()

export type AmbientMixerOptions = Readonly<{
  /**
   * Spread the beds across the stereo field and place calls at random positions (default).
   * Off keeps everything but the waterfall and splashes centered.
   */
  wide?: boolean
  /** The page's audio context, needed to stream the occasional music. Without it, no music. */
  media?: AudioContext
}>

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
  setValueCurveAtTime(values: Float32Array, time: number, duration: number): unknown
}
interface MixerGain extends MixerNode {
  readonly gain: MixerParam
}
interface MixerPanner extends MixerNode {
  readonly pan: MixerParam
}
interface MixerSource extends MixerNode {
  buffer: AudioSample | null
  readonly playbackRate: MixerParam
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
  private readonly next = new Map<string, number>()
  private readonly offsets = new Map<string, number>()
  private readonly loading = new AbortController()
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private started = false
  private active = false
  private ready = false
  private waterfallRequested = false
  private waterfallPan: MixerPanner | undefined
  private nextBird = 0
  private nextOwl = 0
  private lastOwl = -1
  private decodedBytes = 0
  private environment: AmbientEnvironment = {
    solarHour: 0,
    daylight: 0,
    windSpeed: 0,
    rainIntensity: 0,
  }

  private readonly context: AmbientAudioContext
  private format: AudioFormat
  private readonly wide: boolean
  private readonly mediaMaster: GainNode | undefined
  private readonly music: AmbientMusic | undefined
  private readonly splashes = new WaterSoundPicker()

  constructor(
    context: AmbientAudioContext,
    format: AudioFormat = 'mp3',
    options: AmbientMixerOptions = {},
  ) {
    this.context = context
    this.format = format
    this.wide = options.wide ?? true
    this.master = context.createGain()
    this.master.gain.value = 0
    this.master.connect(context.destination)
    for (const layer of AUDIO_LAYERS) {
      const gain = context.createGain()
      gain.gain.value = 0
      gain.connect(this.master)
      this.gains.set(layer, gain)
    }
    const media = options.media
    if (media) {
      // Streamed music follows the same master fades on its own output.
      this.mediaMaster = media.createGain()
      this.mediaMaster.gain.value = 0
      this.mediaMaster.connect(media.destination)
      // Music follows the clips' format, including a fallback to MP3 after an Ogg failure.
      this.music = new AmbientMusic(media, this.mediaMaster, () => this.format)
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

  private async decode(layer: Layer, format: AudioFormat) {
    const response = await fetch(`/audio/${layer}.${format}`, {
      signal: AbortSignal.any([this.loading.signal, AbortSignal.timeout(15000)]),
    })
    if (!response.ok) throw new Error(`Audio ${layer}: ${response.status}`)
    const data = await response.arrayBuffer()
    if (this.disposed) return undefined
    return this.context.decodeAudioData(data)
  }

  private async loadLayer(layer: Layer) {
    const format = this.format
    let buffer: AudioSample | undefined
    try {
      buffer = await this.decode(layer, format)
    } catch (error) {
      if (format === 'mp3' || this.loading.signal.aborted) throw error
      this.format = 'mp3'
      buffer = await this.decode(layer, 'mp3')
    }
    if (!buffer || this.disposed) return undefined
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
    this.music?.setEnvironment(environment)
    this.updateMix()
    this.loadWaterfall()
  }

  /** A localized splash, drop or wave from the scene; ignored while paused or loading. */
  waterSound(event: WaterSoundEvent) {
    if (this.disposed || !this.active || this.context.state !== 'running') return
    const take = this.splashes.pick(event, this.context.currentTime)
    if (!take || take.offset + take.duration > (this.buffers.get('splashes')?.duration ?? 0)) return
    // A pitched take plays for duration / rate, so it reads exactly its own window of the sprite.
    this.voice(
      'splashes',
      this.context.currentTime,
      take.duration / take.rate,
      take.offset,
      0.005,
      {
        pan: take.pan,
        rate: take.rate,
        level: take.level,
      },
    )
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
      gain.gain.setTargetAtTime(layer === 'splashes' ? SPLASH_LEVEL : mix[layer], now, 2)
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

  private fadeMaster(value: number, ramp: number) {
    const now = this.context.currentTime
    this.master.gain.cancelAndHoldAtTime(now)
    this.master.gain.linearRampToValueAtTime(value, now + ramp)
    if (this.mediaMaster) {
      const gain = this.mediaMaster.gain
      gain.cancelAndHoldAtTime(now)
      gain.linearRampToValueAtTime(value, now + ramp)
    }
  }

  private voice(
    layer: Layer,
    at: number,
    duration: number,
    offset = 0,
    fade = 1.5,
    placement: Readonly<{ pan?: number | undefined; rate?: number; level?: number }> = {},
  ) {
    const buffer = this.buffers.get(layer)
    if (!buffer || this.disposed) return
    const source = this.context.createBufferSource(),
      envelope = this.context.createGain()
    source.buffer = buffer
    source.connect(envelope)
    const destination = required(this.gains.get(layer))
    let panner: MixerPanner | undefined
    if (placement.pan === undefined) envelope.connect(destination)
    else {
      panner = this.context.createStereoPanner()
      panner.pan.value = placement.pan
      envelope.connect(panner)
      panner.connect(destination)
    }
    if (placement.rate !== undefined) source.playbackRate.value = placement.rate
    const length = Math.min(fade, duration / 3)
    const level = placement.level ?? 1
    const scaled = (curve: Float32Array) => (level === 1 ? curve : curve.map((v) => v * level))
    envelope.gain.setValueAtTime(0, at)
    envelope.gain.setValueCurveAtTime(scaled(FADE_IN), at, length)
    envelope.gain.setValueCurveAtTime(scaled(FADE_OUT), at + duration - length, length)
    this.voices.set(source, envelope)
    source.addEventListener(
      'ended',
      () => {
        source.disconnect()
        envelope.disconnect()
        panner?.disconnect()
        this.voices.delete(source)
      },
      { once: true },
    )
    source.start(at, offset)
    source.stop(at + duration)
  }

  /** Keeps one channel of a continuous recording going with overlapping random passages. */
  private continue(layer: Layer, channel: string, buffer: AudioSample, now: number, pan?: number) {
    const next = this.next.get(channel) ?? now
    if (next > now + 0.75) return
    const at = Math.max(now, next)
    const previous = this.offsets.get(channel) ?? -Infinity
    const phrase =
      layer === 'water'
        ? waterPhrase(buffer.duration, previous)
        : loopPhrase(buffer.duration, previous)
    this.offsets.set(channel, phrase.offset)
    this.voice(layer, at, phrase.duration, phrase.offset, phrase.fade, { pan })
    this.next.set(channel, at + phrase.duration - phrase.fade)
  }

  private schedule = () => {
    if (this.disposed || !this.active || this.context.state !== 'running') return
    const now = this.context.currentTime
    const mix = ambientMix(this.environment)
    for (const layer of BEDS) {
      const buffer = this.buffers.get(layer)
      if (!buffer) continue
      if (this.wide)
        SIDES.forEach((pan, side) => this.continue(layer, `${layer}:${side}`, buffer, now, pan))
      else this.continue(layer, layer, buffer, now)
    }
    const fall = this.buffers.get('waterfall')
    if (fall && mix.waterfall > 0) this.continue('waterfall', 'waterfall', fall, now)
    if (now >= this.nextBird) {
      // A call every 9-28 s by day; the dawn chorus packs them into overlapping song.
      this.nextBird = now + (9 + Math.random() * 19) * (1 - 0.85 * birdChorus(this.environment))
      const bird = this.buffers.get('birds')
      if (bird && mix.birds > 0.01) {
        const rate = 0.96 + Math.random() * 0.08
        const length = 4 + Math.random() * 4
        const offset = Math.random() * Math.max(0, bird.duration - length * rate)
        const pan = this.wide ? (Math.random() * 2 - 1) * 0.8 : undefined
        this.voice('birds', now, length, offset, 0.8, { pan, rate })
      }
    }
    if (now >= this.nextOwl) {
      this.nextOwl = now + 35 + Math.random() * 60
      const owl = this.buffers.get('owls')
      if (owl && mix.owls > 0.02) {
        this.lastOwl = pickPhrase(OWL_CALLS, this.lastOwl)
        const [offset, length] = required(OWL_CALLS[this.lastOwl])
        const pan = this.wide ? (Math.random() * 2 - 1) * 0.7 : undefined
        if (offset + length <= owl.duration) this.voice('owls', now, length, offset, 0.3, { pan })
      }
    }
    this.music?.tick()
  }

  resume() {
    if (this.disposed || !this.ready) return
    this.active = true
    const now = this.context.currentTime
    if (!this.started) {
      this.nextBird = now + 6 + Math.random() * 14
      this.nextOwl = now + 15 + Math.random() * 30
      this.started = true
    }
    this.fadeMaster(MASTER, 1.5)
    this.schedule()
    clearInterval(this.timer)
    this.timer = setInterval(this.schedule, 250)
  }

  pause() {
    this.active = false
    clearInterval(this.timer)
    this.timer = undefined
    this.fadeMaster(0, 0.04)
    this.music?.pause()
  }

  dispose(fade = 0) {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.loading.abort()
    clearInterval(this.timer)
    const now = this.context.currentTime
    this.fadeMaster(0, fade)
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
      this.music?.dispose()
      this.mediaMaster?.disconnect()
    }
    if (fade) setTimeout(disconnect, fade * 1000 + 30)
    else disconnect()
  }
}
