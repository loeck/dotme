const DAY = 86_400

export const SCRUB = {
  /** Scene seconds per pixel of wheel travel: a 100 px notch moves the sun 30 minutes. */
  wheelSeconds: 18,
  /** Scene seconds per pixel of a two-finger drag: a full-height swipe turns several hours. */
  touchSeconds: 40,
  /** A wheel line or page counts as this many pixels. */
  linePixels: 16,
  pagePixels: 800,
  /** Rate, per second, at which the shown time chases the scrubbed one: a quick time-lapse. */
  follow: 5,
  /** Idle seconds after the last gesture before the clock drifts back to the real hour. */
  hold: 8,
  /** Rate, per second, of the drift back: slower, like the opening time-lapse. */
  settle: 0.55,
} as const

/** Wheel travel in pixels, whatever unit the browser reports it in. */
export function wheelPixels(delta: number, mode: number) {
  if (!Number.isFinite(delta)) return 0
  return delta * (mode === 1 ? SCRUB.linePixels : mode === 2 ? SCRUB.pagePixels : 1)
}

/**
 * An offset, in seconds, added to the real solar clock while the visitor scrubs through the
 * day. The wheel (or a two-finger vertical drag) moves a target; the shown offset chases it so
 * the sky time-lapses instead of jumping. Left alone, the target returns to the nearest whole
 * day, so the scene settles back on the honest local hour by the shortest way forward or back.
 */
export class TimeScrub {
  private target = 0
  private shown = 0
  private lastGesture = -Infinity

  /** Seconds currently added to the solar clock. */
  get offset() {
    return this.shown
  }

  /** True until the clock is back on the real hour. */
  get active() {
    return this.shown !== 0 || this.target !== 0
  }

  /** Scrolling down runs the day forward, scrolling up runs it back. */
  scrub(seconds: number, now: number) {
    if (!Number.isFinite(seconds) || seconds === 0) return
    this.target += seconds
    this.lastGesture = now
  }

  /** Advances the shown offset by `dt` seconds at time `now`, both in seconds. */
  update(dt: number, now: number) {
    if (!(dt > 0)) return
    if (now - this.lastGesture > SCRUB.hold) {
      // Back to the real hour: the nearest whole-day offset shows the same time of day.
      const home = Math.round(this.shown / DAY) * DAY
      this.target = home
      this.lastGesture = -Infinity
      this.shown += (home - this.shown) * (1 - Math.exp(-dt * SCRUB.settle))
      if (Math.abs(home - this.shown) < 1) this.shown = this.target = 0
      return
    }
    this.shown += (this.target - this.shown) * (1 - Math.exp(-dt * SCRUB.follow))
  }

  reset() {
    this.target = this.shown = 0
    this.lastGesture = -Infinity
  }
}
