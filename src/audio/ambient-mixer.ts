import { ambientMix } from './environment'
import type { AmbientEnvironment } from './environment'
import { waterPhrase } from './water-phrases'

export const AUDIO_LAYERS = ['water', 'wind', 'rain', 'insects', 'birds'] as const
type Layer = (typeof AUDIO_LAYERS)[number]
const CROSSFADE = 1.5

/** One context is owned by the gesture component. Everything else loads on demand. */
export class AmbientMixer {
  private readonly master: GainNode
  private readonly gains = new Map<Layer, GainNode>()
  private readonly buffers = new Map<Layer, AudioBuffer>()
  private readonly voices = new Map<AudioBufferSourceNode, GainNode>()
  private readonly next = new Map<Layer, number>()
  private readonly loading = new AbortController()
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false
  private started = false
  private ready = false
  private nextBird = 0
  private waterOffset = -Infinity
  private decodedBytes = 0
  private environment: AmbientEnvironment = {
    solarHour: 0,
    daylight: 0,
    windSpeed: 0,
    rainIntensity: 0,
  }

  constructor(private readonly context: AudioContext) {
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
    const results = await Promise.allSettled(
      AUDIO_LAYERS.map(async (layer) => {
        const response = await fetch(`/audio/${layer}.mp3`, {
          signal: AbortSignal.any([this.loading.signal, AbortSignal.timeout(15000)]),
        })
        if (!response.ok) throw new Error(`Audio ${layer}: ${response.status}`)
        const data = await response.arrayBuffer()
        if (this.disposed) return
        const buffer = await this.context.decodeAudioData(data)
        if (this.disposed) return
        const bytes = buffer.length * buffer.numberOfChannels * 4
        if (this.decodedBytes + bytes > 24 * 1024 * 1024)
          throw new Error('Audio memory budget exceeded')
        this.decodedBytes += bytes
        this.buffers.set(layer, buffer)
      }),
    )
    if (this.disposed) return
    if (results[0]!.status === 'rejected' || !this.buffers.has('water'))
      throw new Error('Water audio unavailable')
    this.ready = true
  }

  setEnvironment(environment: AmbientEnvironment) {
    this.environment = environment
    const mix = ambientMix(environment)
    for (const [layer, gain] of this.gains) {
      gain.gain.cancelAndHoldAtTime(this.context.currentTime)
      gain.gain.setTargetAtTime(mix[layer], this.context.currentTime, 2)
    }
  }

  private voice(layer: Layer, at: number, duration: number, offset = 0, crossfade = CROSSFADE) {
    const buffer = this.buffers.get(layer)
    if (!buffer || this.disposed) return
    const source = this.context.createBufferSource(),
      envelope = this.context.createGain()
    source.buffer = buffer
    source.connect(envelope)
    envelope.connect(this.gains.get(layer)!)
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
    if (this.disposed || this.context.state !== 'running') return
    const now = this.context.currentTime
    for (const [layer, buffer] of this.buffers) {
      if (layer === 'birds') continue
      const next = this.next.get(layer) ?? now
      if (next > now + 0.75) continue
      const at = Math.max(now, next)
      if (layer === 'water') {
        const phrase = waterPhrase(buffer.duration, this.waterOffset)
        this.waterOffset = phrase.offset
        this.voice(layer, at, phrase.duration, phrase.offset, phrase.fade)
        this.next.set(layer, at + phrase.duration - phrase.fade)
      } else {
        this.voice(layer, at, buffer.duration)
        this.next.set(layer, at + buffer.duration - CROSSFADE)
      }
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
    clearInterval(this.timer)
    this.timer = undefined
    this.master.gain.cancelAndHoldAtTime(this.context.currentTime)
    this.master.gain.linearRampToValueAtTime(0, this.context.currentTime + 0.04)
  }

  dispose(fade = 0) {
    if (this.disposed) return
    this.disposed = true
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
      this.master.disconnect()
    }
    if (fade) setTimeout(disconnect, fade * 1000 + 30)
    else disconnect()
  }
}
