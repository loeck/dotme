import { required } from '../invariant'
import { anySignal } from '../weather/signals'
import { ambientMix, ambientTone, birdChorus, rumbleGap, stormy } from './environment'
import type { AmbientEnvironment } from './environment'
import { AmbientMusic } from './music'
import type { MusicState } from './music'
import { reverbBytes, reverbImpulse } from './reverb'
import { skipNote } from './skip-notes'
import type { SkipNoteEvent } from './skip-notes'
import {
  THUNDER_BYTES,
  THUNDER_RATE,
  THUNDER_VARIANTS,
  thunderLevel,
  thunderSamples,
  thunderVariant,
  thunderVoicing,
} from './thunder'
import type { ThunderEvent } from './thunder'
import { clampPan, finiteOr } from './units'
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
/**
 * The landscape's overall level, 6 dB above the 0.38 it long played at, which sounded faint
 * next to other pages. The clips keep -9 dBTP of headroom (docs/living-landscape.md); the
 * limiter below catches the rare peaks the louder master leaves too little room for.
 */
const MASTER = 0.76
/**
 * A gentle peak limiter before the output: beds and calls pass untouched below -6 dBFS, while
 * thunder over a full rain bed, a near splash or music over the beds is held under full scale
 * instead of clipping. Fast attack, a quarter-second release so the rain does not pump.
 */
const LIMITER = { threshold: -6, knee: 4, ratio: 12, attack: 0.003, release: 0.25 } as const
/** Fixed level of the splash takes; each event already carries its distance attenuation. */
const SPLASH_LEVEL = 0.3
/** Peak gain of a skip note before the master: under the splash it rides on. */
const SKIP_NOTE_LEVEL = 0.05
/** Peak gain of thunder from a strike a kilometre away: a felt rumble under the rain bed. */
const THUNDER_LEVEL = 0.55
/** Partials of a skip note: fundamental, a quiet octave and a faint twelfth. */
const SKIP_PARTIALS = [
  [1, 1],
  [2, 0.28],
  [3, 0.07],
] as const
/** Ceiling on decoded audio: every clip, the reverb impulse and the rendered thunder. */
const AUDIO_BUDGET_BYTES = 24 * 1024 * 1024
/** Reverb send levels: owls and thunder carry over the lake, notes and music only a little. */
const SEND = { owls: 0.55, thunder: 0.6, note: 0.35, music: 0.15 } as const
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
  /** A media element primed in the enabling gesture, so later pieces may start (WebKit). */
  musicElement?: HTMLAudioElement | undefined
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
  /** Missing in Firefox (Mozilla bug 1308431); see `holdAt`. */
  cancelAndHoldAtTime?(time: number): unknown
  cancelScheduledValues(time: number): unknown
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
interface MixerFilter extends MixerNode {
  type: string
  readonly frequency: MixerParam
  readonly gain: MixerParam
  readonly Q: MixerParam
}
interface MixerConvolver extends MixerNode {
  buffer: AudioSample | null
  normalize: boolean
}
interface MixerOscillator extends MixerNode {
  readonly frequency: MixerParam
  start(time: number): void
  stop(time: number): void
  addEventListener(type: 'ended', listener: () => void, options: { once: boolean }): void
}
/** A buffer the mixer fills itself, as `AudioBuffer` is. */
interface MixerBuffer extends AudioSample {
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void
}
interface MixerSource extends MixerNode {
  buffer: AudioSample | null
  readonly playbackRate: MixerParam
  start(time: number, offset: number): void
  stop(time: number): void
  addEventListener(type: 'ended', listener: () => void, options: { once: boolean }): void
}
interface CompressorParams {
  readonly threshold: { value: number }
  readonly knee: { value: number }
  readonly ratio: { value: number }
  readonly attack: { value: number }
  readonly release: { value: number }
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
  /** Optional: without oscillators a stone's skips keep their splashes but play no notes. */
  createOscillator?(): MixerOscillator
  /** Optional: without it storms stay silent and there is no reverb. */
  createBuffer?(channels: number, length: number, sampleRate: number): MixerBuffer
  /** Optional: without filters the rain bed, fog damping and thunder play unfiltered. */
  createBiquadFilter?(): MixerFilter
  /** Optional: without it the landscape plays dry. */
  createConvolver?(): MixerConvolver
  /** Optional: without it the master reaches the output unlimited. */
  createDynamicsCompressor?(): MixerNode & CompressorParams
  readonly sampleRate?: number
}

/**
 * Freezes an automated parameter at its current value from `time` on, discarding later events,
 * so a new ramp starts where the sound actually is. `cancelAndHoldAtTime` does exactly that but
 * is missing in Firefox; there, the scheduled events are cancelled and `value` (by default the
 * parameter's last computed value) is pinned instead.
 */
function holdAt(param: MixerParam, time: number, value = param.value) {
  if (param.cancelAndHoldAtTime) {
    param.cancelAndHoldAtTime(time)
    return
  }
  param.cancelScheduledValues(time)
  param.setValueAtTime(value, time)
}

/**
 * The context's output behind the peak limiter (`LIMITER`), or the bare destination where the
 * context has no compressor; `limiters` collects what was created, for disposal.
 */
function limitedOutput<N extends MixerNode>(
  context: Readonly<{ destination: N; createDynamicsCompressor?: () => N & CompressorParams }>,
  limiters: MixerNode[],
): N {
  const limiter = context.createDynamicsCompressor?.()
  if (!limiter) return context.destination
  limiter.threshold.value = LIMITER.threshold
  limiter.knee.value = LIMITER.knee
  limiter.ratio.value = LIMITER.ratio
  limiter.attack.value = LIMITER.attack
  limiter.release.value = LIMITER.release
  limiter.connect(context.destination)
  limiters.push(limiter)
  return limiter
}

/** Runs `task` when the main thread is idle, or soon where idle callbacks are missing. */
function whenIdle(task: () => void) {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(task, { timeout: 2000 })
    return () => cancelIdleCallback(handle)
  }
  const handle = setTimeout(task, 200)
  return () => clearTimeout(handle)
}

/** One context is owned by the sound control. Everything else loads on demand. */
export class AmbientMixer {
  private readonly master: MixerGain
  /** Fog and snow cut the master's highs; absent without filters. */
  private readonly shelf: MixerFilter | undefined
  private readonly rainFilter: MixerFilter | undefined
  /** Places the wind bed upwind of the camera; only in the wide field. */
  private readonly windPan: MixerPanner | undefined
  /** Everything sent to the reverb meets here; the convolver joins once its impulse is built. */
  private readonly reverbIn: MixerGain
  private readonly reverbOut: MixerGain
  private readonly sends: MixerGain[] = []
  /** The peak limiters before the outputs: one, shared with the music in the page's context. */
  private readonly limiters: MixerNode[] = []
  private convolver: MixerConvolver | undefined
  private readonly thunderBuffers: Array<MixerBuffer | undefined> = []
  private cancelIdle: (() => void) | undefined
  private nextRumble = Number.NaN
  /** The master's current linear fade, from `from` at `start` to `to` at `end`. */
  private fade = { from: 0, to: 0, start: 0, end: 0 }
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
  /** Budget held back for the synthesised reverb and thunder, which come after the clips. */
  private readonly reservedBytes: number
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
    const media = options.media
    // In the page's single context the landscape and the music share one limiter, so their sum
    // is held under full scale too.
    const mediaOutput = media ? limitedOutput<AudioNode>(media, this.limiters) : undefined
    const landscapeOutput: MixerNode =
      mediaOutput && media === context ? mediaOutput : limitedOutput(context, this.limiters)
    this.master = context.createGain()
    this.master.gain.value = 0
    this.shelf = context.createBiquadFilter?.()
    if (this.shelf) {
      this.shelf.type = 'highshelf'
      this.shelf.frequency.value = 2000
      this.shelf.gain.value = 0
      this.master.connect(this.shelf)
      this.shelf.connect(landscapeOutput)
    } else this.master.connect(landscapeOutput)
    this.rainFilter = context.createBiquadFilter?.()
    if (this.rainFilter) {
      this.rainFilter.type = 'lowpass'
      this.rainFilter.frequency.value = 11_000
      this.rainFilter.Q.value = 0.5
      this.rainFilter.connect(this.master)
    }
    if (this.wide) {
      this.windPan = context.createStereoPanner()
      this.windPan.connect(this.master)
    }
    for (const layer of AUDIO_LAYERS) {
      const gain = context.createGain()
      gain.gain.value = 0
      if (layer === 'rain' && this.rainFilter) gain.connect(this.rainFilter)
      else if (layer === 'wind' && this.windPan) gain.connect(this.windPan)
      else gain.connect(this.master)
      this.gains.set(layer, gain)
    }
    this.reverbIn = context.createGain()
    this.reverbOut = context.createGain()
    this.reverbOut.gain.value = 0
    this.reverbOut.connect(this.master)
    this.send(required(this.gains.get('owls')), SEND.owls)
    const synthesis = context.createBuffer ? THUNDER_BYTES : 0
    const room = context.createConvolver && context.createBuffer ? reverbBytes(this.rate) : 0
    this.reservedBytes = synthesis + room
    if (media && mediaOutput) {
      // Streamed music follows the same master fades on its own output.
      this.mediaMaster = media.createGain()
      this.mediaMaster.gain.value = 0
      this.mediaMaster.connect(mediaOutput)
      // Music follows the clips' format, including a fallback to MP3 after an Ogg failure.
      this.music = new AmbientMusic(media, this.mediaMaster, () => this.format, {
        element: options.musicElement,
      })
      // In the page's single context, the music also reaches the shared reverb, lightly.
      if (media === context) {
        const output: MixerNode = this.music.output
        this.send(output, SEND.music)
      }
    }
  }

  private get rate() {
    return this.context.sampleRate ?? 32_000
  }

  /** What the occasional music is doing, for diagnostics and tests. */
  get musicState(): MusicState | undefined {
    return this.music?.state
  }

  /** A send from `node` to the shared reverb. Long-lived sends are released on disposal. */
  private send(node: MixerNode, level: number, transient = false) {
    const gain = this.context.createGain()
    gain.gain.value = level
    node.connect(gain)
    gain.connect(this.reverbIn)
    if (!transient) this.sends.push(gain)
    return gain
  }

  /**
   * Builds the reverb's impulse response once: a small stereo buffer of decaying noise at the
   * context's rate (the convolver requires it), accounted in the memory budget.
   */
  private buildReverb() {
    const context = this.context
    if (this.convolver || !context.createConvolver || !context.createBuffer) return
    const [left, right] = reverbImpulse(this.rate)
    const impulse = context.createBuffer(2, left.length, this.rate)
    impulse.copyToChannel(left, 0)
    impulse.copyToChannel(right, 1)
    const convolver = context.createConvolver()
    convolver.normalize = true
    convolver.buffer = impulse
    this.reverbIn.connect(convolver)
    convolver.connect(this.reverbOut)
    this.convolver = convolver
  }

  /** Renders one peal for each variant distance, one per idle period, so no frame stalls. */
  private prepareThunder() {
    if (this.disposed || !this.context.createBuffer) return
    const index = THUNDER_VARIANTS.findIndex((_, variant) => !this.thunderBuffers[variant])
    if (index < 0) return
    this.peal(index)
    this.cancelIdle = whenIdle(() => this.prepareThunder())
  }

  private peal(index: number) {
    const existing = this.thunderBuffers[index]
    if (existing || !this.context.createBuffer) return existing
    const samples = thunderSamples(THUNDER_RATE, THUNDER_VARIANTS[index] ?? 3000)
    const buffer = this.context.createBuffer(1, samples.length, THUNDER_RATE)
    buffer.copyToChannel(samples, 0)
    this.thunderBuffers[index] = buffer
    return buffer
  }

  async load() {
    // Water is requested first; all layers then download and decode in parallel.
    const results = await Promise.allSettled(AUDIO_LAYERS.map((layer) => this.loadLayer(layer)))
    if (this.disposed) return
    // Admission follows the fixed layer order, not decoding order, so the same layers are kept
    // on every visit, and the base water, first in that order, can never be the one refused.
    results.forEach((result, index) => {
      const layer = required(AUDIO_LAYERS[index])
      if (result.status === 'fulfilled' && result.value && this.admit(result.value))
        this.buffers.set(layer, result.value)
    })
    if (!this.buffers.has('water')) throw new Error('Water audio unavailable')
    this.ready = true
    this.buildReverb()
    this.cancelIdle = whenIdle(() => this.prepareThunder())
    this.updateMix()
    this.loadWaterfall()
  }

  /** Counts a decoded clip against the budget, less what the synthesised sounds need. */
  private admit(buffer: AudioSample) {
    const bytes = buffer.length * buffer.numberOfChannels * 4
    if (this.decodedBytes + bytes + this.reservedBytes > AUDIO_BUDGET_BYTES) return false
    this.decodedBytes += bytes
    return true
  }

  private async decode(layer: Layer, format: AudioFormat) {
    const response = await fetch(`/audio/${layer}.${format}`, {
      signal: anySignal([this.loading.signal, AbortSignal.timeout(15000)]),
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
    return buffer && !this.disposed ? buffer : undefined
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
        if (!buffer || this.disposed || !this.admit(buffer)) return undefined
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

  /**
   * A soft bell-like note for a stone's touchdown, tuned to the music (see `skipNote`): a sine
   * with a quiet octave and twelfth, struck in 6 ms and ringing out over about a second, placed
   * where the stone touched the water.
   */
  skipNote(event: SkipNoteEvent) {
    const context = this.context
    if (this.disposed || !this.active || context.state !== 'running' || !context.createOscillator)
      return
    const intensity = Math.max(0, Math.min(1, finiteOr(event.intensity, 0)))
    if (intensity < 0.02) return
    const at = context.currentTime
    const frequency = skipNote(event.index, event.sinking, this.environment.daylight)
    const envelope = context.createGain(),
      panner = context.createStereoPanner()
    panner.pan.value = clampPan(event.pan)
    envelope.connect(panner)
    panner.connect(this.master)
    const reverb = this.send(panner, SEND.note, true)
    const peak = SKIP_NOTE_LEVEL * intensity * (event.sinking ? 0.7 : 1)
    const ring = event.sinking ? 0.6 : 0.35
    envelope.gain.setValueAtTime(0, at)
    envelope.gain.linearRampToValueAtTime(peak, at + 0.006)
    envelope.gain.setTargetAtTime(0, at + 0.006, ring)
    const end = at + 0.006 + ring * 6
    let pending = SKIP_PARTIALS.length
    for (const [multiple, level] of SKIP_PARTIALS) {
      const oscillator = context.createOscillator()
      const partial = context.createGain()
      oscillator.frequency.value = frequency * multiple
      partial.gain.value = level
      oscillator.connect(partial)
      partial.connect(envelope)
      oscillator.addEventListener(
        'ended',
        () => {
          oscillator.disconnect()
          partial.disconnect()
          if (--pending === 0) {
            envelope.disconnect()
            panner.disconnect()
            reverb.disconnect()
          }
        },
        { once: true },
      )
      oscillator.start(at)
      oscillator.stop(end)
    }
  }

  /**
   * One peal of thunder, started when its sound arrives. The peals are pre-rendered at idle
   * (one near, one middle, one far); each strike takes the closest and varies its pitch,
   * low-pass and placement, so no two strikes rumble alike.
   */
  thunder(event: ThunderEvent) {
    const context = this.context
    if (this.disposed || !this.active || context.state !== 'running' || !context.createBuffer)
      return
    const level = thunderLevel(event.distance, event.intensity) * THUNDER_LEVEL
    if (level < 0.01) return
    // A strike before the idle rendering reached its variant renders it now (a few ms at 8 kHz).
    const buffer = this.peal(thunderVariant(event.distance))
    if (!buffer) return
    const voicing = thunderVoicing(event.distance)
    const source = context.createBufferSource(),
      envelope = context.createGain(),
      panner = context.createStereoPanner(),
      filter = context.createBiquadFilter?.()
    source.buffer = buffer
    source.playbackRate.value = voicing.rate
    envelope.gain.value = level
    panner.pan.value = clampPan(event.pan)
    source.connect(envelope)
    if (filter) {
      filter.type = 'lowpass'
      filter.frequency.value = voicing.cutoff
      envelope.connect(filter)
      filter.connect(panner)
    } else envelope.connect(panner)
    panner.connect(this.master)
    const reverb = this.send(panner, SEND.thunder, true)
    source.addEventListener(
      'ended',
      () => {
        source.disconnect()
        envelope.disconnect()
        filter?.disconnect()
        panner.disconnect()
        reverb.disconnect()
      },
      { once: true },
    )
    source.start(context.currentTime + Math.max(0, finiteOr(event.delay, 0)), 0)
  }

  /**
   * Under reduced motion the scene shows no lightning, so a storm would fall silent: the mixer
   * schedules its own distant, low rumble every 18–48 s instead, with no flash to match.
   */
  private rumble(now: number) {
    if (!this.environment.reducedMotion || !stormy(this.environment)) {
      this.nextRumble = Number.NaN
      return
    }
    if (Number.isNaN(this.nextRumble)) this.nextRumble = now + rumbleGap()
    if (now < this.nextRumble) return
    this.nextRumble = now + rumbleGap()
    this.thunder({
      distance: 4500 + Math.random() * 3000,
      delay: 0,
      intensity: 0.6 + Math.random() * 0.4,
      pan: this.wide ? Math.random() * 1.6 - 0.8 : 0,
    })
  }

  private updateMix() {
    // An unavailable secondary recording must not attenuate the base water.
    const mix = ambientMix(
      this.buffers.has('waterfall')
        ? this.environment
        : { ...this.environment, waterfall: { intensity: 0, pan: 0 } },
    )
    const tone = ambientTone(this.environment)
    const now = this.context.currentTime
    // These parameters only ever follow targets: a new target simply takes over from wherever
    // the previous one had got to, so nothing needs cancelling (or holding, which Firefox lacks).
    for (const [layer, gain] of this.gains)
      gain.gain.setTargetAtTime(layer === 'splashes' ? SPLASH_LEVEL : mix[layer], now, 2)
    if (this.waterfallPan)
      this.waterfallPan.pan.setTargetAtTime(clampPan(this.environment.waterfall?.pan ?? 0), now, 2)
    this.windPan?.pan.setTargetAtTime(tone.windPan, now, 3)
    this.rainFilter?.frequency.setTargetAtTime(tone.rainCutoff, now, 2)
    this.shelf?.gain.setTargetAtTime(tone.masterShelf, now, 3)
    this.reverbOut.gain.setTargetAtTime(this.convolver ? tone.reverb : 0, now, 2)
  }

  private fadeMaster(value: number, ramp: number) {
    const now = this.context.currentTime
    // Where the current fade has got to, for browsers that cannot hold a ramp themselves: exact
    // for the linear fades the master only ever makes, unlike a possibly stale `param.value`.
    const { from, to, start, end } = this.fade
    const progress = end > start ? Math.max(0, Math.min(1, (now - start) / (end - start))) : 1
    const current = from + (to - from) * progress
    this.fade = { from: current, to: value, start: now, end: now + ramp }
    holdAt(this.master.gain, now, current)
    this.master.gain.linearRampToValueAtTime(value, now + ramp)
    if (this.mediaMaster) {
      const gain = this.mediaMaster.gain
      holdAt(gain, now, current)
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
  private continue(
    layer: Layer,
    channel: string,
    buffer: AudioSample,
    now: number,
    pan?: number,
    rate = 1,
  ) {
    const next = this.next.get(channel) ?? now
    if (next > now + 0.75) return
    const at = Math.max(now, next)
    const previous = this.offsets.get(channel) ?? -Infinity
    // Phrases are chosen in played seconds; a faster passage reads proportionally more audio.
    const length = buffer.duration / rate
    const phrase = layer === 'water' ? waterPhrase(length, previous) : loopPhrase(length, previous)
    this.offsets.set(channel, phrase.offset)
    this.voice(layer, at, phrase.duration, phrase.offset * rate, phrase.fade, {
      pan,
      ...(rate === 1 ? {} : { rate }),
    })
    this.next.set(channel, at + phrase.duration - phrase.fade)
  }

  private schedule = () => {
    if (this.disposed || !this.active || this.context.state !== 'running') return
    const now = this.context.currentTime
    const mix = ambientMix(this.environment)
    const { insectRate } = ambientTone(this.environment)
    for (const layer of BEDS) {
      const buffer = this.buffers.get(layer)
      if (!buffer) continue
      // Crickets chirp faster in the warm: new passages pick up the current rate.
      const rate = layer === 'insects' ? insectRate : 1
      if (this.wide)
        SIDES.forEach((pan, side) =>
          this.continue(layer, `${layer}:${side}`, buffer, now, pan, rate),
        )
      else this.continue(layer, layer, buffer, now, undefined, rate)
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
    this.rumble(now)
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
    this.cancelIdle?.()
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
      for (const gain of this.sends) gain.disconnect()
      this.waterfallPan?.disconnect()
      this.windPan?.disconnect()
      this.rainFilter?.disconnect()
      this.reverbIn.disconnect()
      this.convolver?.disconnect()
      this.reverbOut.disconnect()
      this.master.disconnect()
      this.shelf?.disconnect()
      this.music?.dispose()
      this.mediaMaster?.disconnect()
      for (const limiter of this.limiters) limiter.disconnect()
    }
    if (fade) setTimeout(disconnect, fade * 1000 + 30)
    else disconnect()
  }
}
