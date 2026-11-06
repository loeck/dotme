export const LIGHTNING = {
  /** Mean seconds between strikes in a storm, and the shortest gap. */
  meanGap: 14,
  minGap: 4,
  /** Seconds each stroke's light takes to fall by a factor e. */
  decay: 0.07,
  /**
   * Seconds between a strike's main stroke and its one return stroke. Real return strokes
   * come faster, but at most two flashes within a second stay under the three-per-second
   * photosensitive limit (WCAG 2.3.1).
   */
  returnGap: [0.35, 0.5],
  /** Heaviest rain that still counts as a shower rather than a storm. */
  stormRain: 0.75,
  /** Speed of sound, metres per second: thunder trails the flash by distance / 343 s. */
  soundSpeed: 343,
} as const

/** A strike as it reaches the scene: its light now, its thunder `delay` seconds later. */
export type Strike = Readonly<{
  /** Metres from the viewer, 1–8 km. */
  distance: number
  /** Thunder delay, seconds. */
  delay: number
  /** Brightness of the flash, 0–1: nearer strikes light the scene more. */
  intensity: number
  /** Stereo position of the rumble, -1 (left) to 1 (right). */
  pan: number
}>

type Stroke = { at: number; peak: number }

/**
 * Storm lightning seen through cloud: sheet flashes rather than bolts. Each strike is a main
 * stroke, sometimes followed by a fainter return stroke, and its thunder follows at the speed
 * of sound. Strikes come at random, on average every
 * fourteen seconds, only while the storm lasts.
 */
export class Lightning {
  private nextAt: number
  private readonly strokes: Stroke[] = []
  private readonly random: () => number

  constructor(random: () => number = Math.random, now = 0) {
    this.random = random
    this.nextAt = now + this.gap()
  }

  private gap() {
    // Exponential gaps: strikes are independent, so they bunch and pause as storms do.
    return LIGHTNING.minGap - Math.log(1 - this.random()) * (LIGHTNING.meanGap - LIGHTNING.minGap)
  }

  /**
   * Advances to `now` (seconds) and returns the flash brightness, 0 when dark. While `stormy`,
   * a due strike is reported once through `onStrike`.
   */
  update(now: number, stormy: boolean, onStrike?: (strike: Strike) => void) {
    if (!stormy) this.nextAt = Math.max(this.nextAt, now + LIGHTNING.minGap)
    else if (now >= this.nextAt) {
      this.nextAt = now + this.gap()
      const distance = 1000 + this.random() ** 1.5 * 7000
      const intensity = Math.min(1, 1600 / distance)
      this.strokes.push({ at: now, peak: intensity })
      if (this.random() < 0.5) {
        const [low, high] = LIGHTNING.returnGap
        const at = now + low + this.random() * (high - low)
        this.strokes.push({ at, peak: intensity * (0.35 + this.random() * 0.4) })
      }
      onStrike?.({
        distance,
        delay: distance / LIGHTNING.soundSpeed,
        intensity,
        pan: this.random() * 1.6 - 0.8,
      })
    }
    let flash = 0
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const stroke = this.strokes[i]
      if (!stroke) continue
      const age = now - stroke.at
      if (age > LIGHTNING.decay * 8) this.strokes.splice(i, 1)
      else if (age >= 0) flash += stroke.peak * Math.exp(-age / LIGHTNING.decay)
    }
    // Overlapping strokes never add up past one full flash.
    return Math.min(1, flash)
  }

  reset(now: number) {
    this.strokes.length = 0
    this.nextAt = now + this.gap()
  }
}
