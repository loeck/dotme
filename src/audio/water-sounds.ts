/** A localized water event from the scene, already attenuated by distance and placed in stereo. */
export type WaterSoundEvent = Readonly<{
  kind: WaterSoundKind
  /** 0–1 after distance attenuation. */
  intensity: number
  /** -1 (left) to 1 (right). */
  pan: number
}>
export type WaterSoundKind = 'burst' | 'wave' | 'drop'
export type WaterSoundWindow = Readonly<{ kind: WaterSoundKind; offset: number; duration: number }>

/**
 * Windows in splashes.ogg, a sprite of generated takes: pointer splashes, small waves
 * slapping the bank and single drops. Offsets and durations in seconds.
 */
export const WATER_SOUNDS: readonly WaterSoundWindow[] = [
  { kind: 'burst', offset: 0, duration: 1.2 },
  { kind: 'wave', offset: 1.25, duration: 1.55 },
  ...[2.85, 3.2, 3.55, 3.9, 4.25, 4.6, 4.95].map((offset) => ({
    kind: 'drop' as const,
    offset,
    duration: 0.3,
  })),
]

/** Drops are the most frequent event: cap their rate so a shower of returns stays a patter. */
const DROP_GAP = 0.05
const DROPS_PER_SECOND = 8
const finite = (n: number) => (Number.isFinite(n) ? n : 0)

/**
 * Picks a take for each audible water event and drops the ones that would only clutter:
 * near-silent distant events, and drops beyond a patter.
 */
export class WaterSoundPicker {
  private lastDrop = -Infinity
  private window = -Infinity
  private count = 0
  private readonly last = new Map<WaterSoundKind, number>()
  private readonly windows: readonly WaterSoundWindow[]
  private readonly random: () => number

  constructor(windows: readonly WaterSoundWindow[] = WATER_SOUNDS, random = Math.random) {
    this.windows = windows
    this.random = random
  }

  pick(event: WaterSoundEvent, now: number) {
    const intensity = Math.max(0, Math.min(1, finite(event.intensity)))
    if (intensity < 0.03) return undefined
    if (event.kind === 'drop') {
      if (now - this.window >= 1) {
        this.window = now
        this.count = 0
      }
      if (now - this.lastDrop < DROP_GAP || this.count >= DROPS_PER_SECOND) return undefined
      this.lastDrop = now
      this.count++
    }
    const takes = this.windows.flatMap((window, index) =>
      window.kind === event.kind ? [index] : [],
    )
    if (!takes.length) return undefined
    // Never the same take twice in a row for one kind.
    const previous = this.last.get(event.kind)
    const choices = takes.length > 1 ? takes.filter((index) => index !== previous) : takes
    const index = choices[Math.floor(this.random() * choices.length)] ?? takes[0] ?? 0
    this.last.set(event.kind, index)
    const window = this.windows[index]
    if (!window) return undefined
    return {
      ...window,
      level: intensity,
      pan: Math.max(-1, Math.min(1, finite(event.pan))),
      // Slight pitch variation keeps repeated takes from sounding identical.
      rate: 0.92 + this.random() * 0.16,
    }
  }
}
