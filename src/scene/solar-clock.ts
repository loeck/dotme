import { required } from '../invariant'
const DAY = 86400
export const wrapDay = (seconds: number) => ((seconds % DAY) + DAY) % DAY

/** Day/night orbit endpoints as seconds past local midnight. */
export interface SolarEndpoints {
  sunrise: number
  sunset: number
}

export const DEFAULT_SOLAR: SolarEndpoints = { sunrise: 21_600, sunset: 64_800 }

export function parseInitialTime(value: string | null, local = new Date()): number {
  if (value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    const [hours, minutes] = value.split(':').map(Number)
    return required(hours) * 3600 + required(minutes) * 60
  }
  return local.getHours() * 3600 + local.getMinutes() * 60 + local.getSeconds()
}

/**
 * Share of the day arc between the horizon and the intro's opening sun. The orbit's
 * elevation is `asin(0.85 sin(πs))`, so 5.5% of the arc puts the sun about 8.5° up:
 * the middle of the golden-hour band in `goldenHourShare`.
 */
export const INTRO_ARC_SHARE = 0.055
/** Real seconds the intro holds its golden opening before the clock starts to run. */
export const INTRO_HOLD = 4
/** Real seconds from the opening to the real local time. */
export const INTRO_DURATION = 22
/** Shorter gaps are not worth a time-lapse: the visit already opens near a golden hour. */
const INTRO_MIN_GAP = 600

/**
 * The scene opens on the most recent golden hour (low morning or evening sun) and
 * time-lapses forward to the real local time: a first visit always sees the light at its
 * best, then the clock settles on the honest hour. Returns the gap to replay, in seconds.
 */
export function introGap(now: number, solar: SolarEndpoints = DEFAULT_SOLAR) {
  const span = solar.sunset - solar.sunrise
  const endpoints = span > 0 && span < DAY ? solar : DEFAULT_SOLAR
  const lead = (endpoints.sunset - endpoints.sunrise) * INTRO_ARC_SHARE
  const gap = Math.min(
    wrapDay(now - (endpoints.sunrise + lead)),
    wrapDay(now - (endpoints.sunset - lead)),
  )
  return gap < INTRO_MIN_GAP ? 0 : gap
}

/** Remaining share of the intro's replayed gap, 1 at the opening and 0 once it ends. */
export function introRemaining(elapsed: number) {
  const t = Math.max(0, Math.min(1, (elapsed - INTRO_HOLD) / (INTRO_DURATION - INTRO_HOLD)))
  // Quintic smootherstep: the lapse leaves the golden hour and lands on real time gently.
  return 1 - t * t * t * (t * (t * 6 - 15) + 10)
}

/** Wall time, independent of the water solver's capped timestep. */
export class SolarClock {
  readonly initialSeconds: number
  readonly timeScale: number
  /** Seconds replayed by the opening time-lapse; zero when it is skipped. */
  readonly introGap: number
  private readonly frozen: boolean
  private readonly startedAt: number
  constructor(
    initialSeconds: number,
    frozen = false,
    startedAt = performance.now(),
    timeScale = 1,
    replayed = 0,
  ) {
    this.initialSeconds = initialSeconds
    this.frozen = frozen
    this.startedAt = startedAt
    this.timeScale = timeScale
    this.introGap = frozen ? 0 : Math.max(0, replayed)
  }

  elapsed(now = performance.now()) {
    return this.frozen ? 0 : Math.max(0, (now - this.startedAt) / 1000)
  }

  /** The same clock, its intro restarting at `now`: the first presented frame, after loading. */
  restartIntro(now: number) {
    if (this.introGap === 0) return this
    const real = wrapDay(this.initialSeconds + this.elapsed(now) * this.timeScale)
    return new SolarClock(real, this.frozen, now, this.timeScale, this.introGap)
  }

  seconds(elapsed: number) {
    const replay = this.introGap * introRemaining(elapsed)
    return wrapDay(this.initialSeconds + elapsed * this.timeScale - replay)
  }
}
