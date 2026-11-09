import type { AudioFormat } from './ambient-mixer'
import type { AmbientEnvironment } from './environment'
import { unit } from './units'

/** Music level under the shared master, about the loudness of the birds. */
const LEVEL = 0.11

type MusicMood = 'day' | 'night'
/**
 * `waiting` until a piece is due, `playing` during one, `blocked` when the browser refused to
 * start it (autoplay policy), `failed` after a load or decode error. The last two retry with
 * the next piece.
 */
export type MusicState = 'waiting' | 'playing' | 'blocked' | 'failed'

/** Day pieces in daylight without heavy rain; the night piece otherwise. */
export function musicMood(environment: AmbientEnvironment): MusicMood {
  return unit(environment.daylight) > 0.45 && unit(environment.rainIntensity) < 0.5
    ? 'day'
    : 'night'
}

/** Silence after a piece: several minutes, longer in rain, so the landscape carries the sound. */
export function musicGap(environment: AmbientEnvironment, random = Math.random) {
  return (150 + random() * 150) * (1 + unit(environment.rainIntensity) * 0.5)
}

interface MusicNode {
  connect(destination: MusicNode): unknown
  disconnect(): void
}
interface MusicGain extends MusicNode {
  readonly gain: { value: number }
}
/** The parts of an `AudioContext` the music uses; tests provide the same contract. */
export interface MusicContext {
  readonly currentTime: number
  createGain(): MusicGain
  createMediaElementSource(element: HTMLMediaElement): MusicNode
}

export type AmbientMusicOptions = Readonly<{
  random?: () => number
  /** Delay before the first piece, so the landscape is heard alone first. */
  firstPiece?: number
  /** An element primed in the enabling gesture (`primeMediaElement`), reused for every piece. */
  element?: HTMLAudioElement | undefined
}>

let reported = false

/**
 * Occasional music in the manner of open-world game scores: one generated piece, then
 * minutes of silence. Pieces stream through a media element instead of being decoded, so
 * a minute and a half of stereo music adds nothing to the decoded-audio budget, and the file
 * is only requested when its first piece is due.
 */
export class AmbientMusic {
  /** The music's own output, before the shared master; the mixer also sends it to the reverb. */
  readonly output: MusicGain
  private readonly audio: MusicContext
  private readonly format: () => AudioFormat
  private readonly random: () => number
  private element: HTMLAudioElement | undefined
  private source: MusicNode | undefined
  private environment: AmbientEnvironment = {
    solarHour: 12,
    daylight: 1,
    windSpeed: 0,
    rainIntensity: 0,
  }
  /** Set on the first tick, so the first delay counts from when sound actually starts. */
  private nextPiece = NaN
  private readonly firstPiece: number
  private playing = false
  private disposed = false
  private current: MusicState = 'waiting'

  constructor(
    audio: MusicContext,
    destination: MusicNode,
    format: () => AudioFormat,
    options: AmbientMusicOptions = {},
  ) {
    this.audio = audio
    this.format = format
    this.random = options.random ?? Math.random
    this.output = audio.createGain()
    this.output.gain.value = LEVEL
    this.output.connect(destination)
    this.firstPiece = options.firstPiece ?? 30 + this.random() * 20
    // A primed element joins the graph now, while the context is known to be running.
    if (options.element) this.attach(options.element)
  }

  /** What the music is doing; `blocked` means the browser refused playback outside a gesture. */
  get state(): MusicState {
    return this.current
  }

  setEnvironment(environment: AmbientEnvironment) {
    this.environment = environment
  }

  private attach(element: HTMLAudioElement) {
    this.element = element
    element.preload = 'auto'
    element.addEventListener('ended', () => this.finish('waiting'))
    element.addEventListener('error', () => {
      if (this.playing) this.finish('failed')
    })
    this.source = this.audio.createMediaElementSource(element)
    this.source.connect(this.output)
    return element
  }

  /** Called from the mixer's scheduler while playback is active. */
  tick() {
    if (Number.isNaN(this.nextPiece)) this.nextPiece = this.audio.currentTime + this.firstPiece
    if (this.disposed || this.playing || this.audio.currentTime < this.nextPiece) return
    this.playing = true
    this.current = 'playing'
    const element = this.element ?? this.attach(new Audio())
    element.muted = false
    element.src = `/audio/music-${musicMood(this.environment)}.${this.format()}`
    element.currentTime = 0
    element.play().catch((error: unknown) => {
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError'
      if (!reported) {
        reported = true
        console.debug('Ambient music could not start', error)
      }
      this.finish(blocked ? 'blocked' : 'failed')
    })
  }

  private finish(state: MusicState) {
    if (this.disposed || !this.playing) return
    this.playing = false
    this.current = state
    this.nextPiece = this.audio.currentTime + musicGap(this.environment, this.random)
  }

  /** A hidden page stops its piece; the next one waits a while after returning. */
  pause() {
    if (!this.playing) return
    this.element?.pause()
    this.playing = false
    this.current = 'waiting'
    this.nextPiece = this.audio.currentTime + 60 + this.random() * 60
  }

  dispose() {
    this.disposed = true
    if (this.element) {
      this.element.pause()
      this.element.removeAttribute('src')
      this.element.load()
    }
    this.source?.disconnect()
    this.output.disconnect()
  }
}
