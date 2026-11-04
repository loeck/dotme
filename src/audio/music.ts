import type { AudioFormat } from './ambient-mixer'
import type { AmbientEnvironment } from './environment'

const unit = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

/** Music level under the shared master, about the loudness of the birds. */
const LEVEL = 0.11

type MusicMood = 'day' | 'night'

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

/**
 * Occasional music in the manner of open-world game scores: one generated piece, then
 * minutes of silence. Pieces stream through a media element instead of being decoded, so
 * a minute and a half of stereo music adds nothing to the decoded-audio budget, and the file
 * is only requested when its first piece is due.
 */
export class AmbientMusic {
  private readonly gain: GainNode
  private readonly audio: AudioContext
  private readonly format: () => AudioFormat
  private readonly random: () => number
  private element: HTMLAudioElement | undefined
  private source: MediaElementAudioSourceNode | undefined
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

  constructor(
    audio: AudioContext,
    destination: AudioNode,
    format: () => AudioFormat,
    random: () => number = Math.random,
    /** Delay before the first piece, so the landscape is heard alone first. */
    firstPiece = 30 + random() * 20,
  ) {
    this.audio = audio
    this.format = format
    this.random = random
    this.gain = audio.createGain()
    this.gain.gain.value = LEVEL
    this.gain.connect(destination)
    this.firstPiece = firstPiece
  }

  setEnvironment(environment: AmbientEnvironment) {
    this.environment = environment
  }

  /** Called from the mixer's scheduler while playback is active. */
  tick() {
    if (Number.isNaN(this.nextPiece)) this.nextPiece = this.audio.currentTime + this.firstPiece
    if (this.disposed || this.playing || this.audio.currentTime < this.nextPiece) return
    this.playing = true
    const element = this.element ?? new Audio()
    if (!this.element) {
      this.element = element
      element.preload = 'auto'
      element.addEventListener('ended', () => this.finish())
      element.addEventListener('error', () => this.finish())
      this.source = this.audio.createMediaElementSource(element)
      this.source.connect(this.gain)
    }
    element.src = `/audio/music-${musicMood(this.environment)}.${this.format()}`
    element.currentTime = 0
    element.play().catch(() => this.finish())
  }

  private finish() {
    if (this.disposed || !this.playing) return
    this.playing = false
    this.nextPiece = this.audio.currentTime + musicGap(this.environment, this.random)
  }

  /** A hidden page stops its piece; the next one waits a while after returning. */
  pause() {
    if (!this.playing) return
    this.element?.pause()
    this.playing = false
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
    this.gain.disconnect()
  }
}
