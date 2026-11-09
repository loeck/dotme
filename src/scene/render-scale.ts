/**
 * Dynamic resolution: the share of the drawing buffer the scene renders at, chosen from recent
 * frame intervals. Steps are quantized so render targets reallocate rarely, and every change is
 * held for a while so the image never pumps.
 */
export const RENDER_SCALE = {
  steps: [0.6, 0.7, 0.8, 0.9, 1],
  /** Interval statistics cover this much recent time. */
  windowMs: 1500,
  /** Minimum time between two changes (each change also restarts the window). */
  holdMs: 2000,
  /** Frames before this, from the first one, are ignored: the intro and its first sweeps. */
  warmupMs: 5000,
  /** A frame is late beyond this share of the budget; the 90th percentile decides. */
  overBudget: 1.25,
  /** Frames within this share of the budget leave room for a larger image. */
  headroom: 1.08,
  /** Main-thread work above this share of the budget means a smaller image would not help. */
  cpuBound: 0.8,
  /** Calm time before stepping up; doubled (to the maximum) when a step up had to be undone. */
  upgradeAfterMs: 4000,
  maxUpgradeAfterMs: 32000,
  /** Late frames at the smallest step for this long switch to the reduced budget. */
  degradeAfterMs: 6000,
  /** Intervals longer than this are pauses (background, hitches), not load. */
  pauseMs: 250,
  /** Statistics are re-evaluated at most this often. */
  evaluateMs: 250,
  /**
   * A capped frame rate (a browser's battery saver holding the page at 30 Hz): late frames all
   * within this spread (90th over 10th percentile), at a whole multiple of the budget within
   * this tolerance, that a smaller image did not shorten by this share.
   */
  cappedSpread: 1.1,
  cappedTolerance: 0.06,
  cappedGain: 0.95,
} as const

const ascending = (a: number, b: number) => a - b

/** The p-quantile (p in [0, 1]) of `values`, which it sorts in place. */
function quantile(values: number[], p: number) {
  values.sort(ascending)
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))
  return values[index] ?? 0
}

export class RenderScaleController {
  /** The interval aimed for: the scene's cap, or the slower rate the browser holds it to. */
  private budgetMs: number
  private readonly targetBudgetMs: number
  /** Where a descent on capped-looking frames began: its step and frame interval. */
  private cappedDescent: { from: number; late: number } | null = null
  private step: number = RENDER_SCALE.steps.length - 1
  private readonly times: number[] = []
  private readonly intervals: number[] = []
  private readonly cpu: number[] = []
  private readonly scratch: number[] = []
  private startedAt: number | null = null
  private windowStart: number | null = null
  private changedAt = -Infinity
  private raisedAt = -Infinity
  private evaluatedAt = -Infinity
  private calmSince: number | null = null
  private lateAtMinimumSince: number | null = null
  private upgradeAfter: number = RENDER_SCALE.upgradeAfterMs
  /** Set once frames stayed late at the smallest step; it never clears. */
  degraded = false

  /** `budgetMs` is the frame interval the scene aims for (1000 / its frame-rate cap). */
  constructor(budgetMs: number) {
    this.budgetMs = this.targetBudgetMs = budgetMs
  }

  /** Steady late frames at a whole multiple (2 or more) of the frame budget. */
  private looksCapped(late: number) {
    const steady = late <= this.percentile(this.intervals, 0.1) * RENDER_SCALE.cappedSpread
    const multiple = late / this.targetBudgetMs
    const whole = Math.round(multiple)
    return steady && whole >= 2 && Math.abs(multiple - whole) <= RENDER_SCALE.cappedTolerance
  }

  get scale(): number {
    return RENDER_SCALE.steps[this.step] ?? 1
  }

  /** Forget recent frames, e.g. after focus or visibility changes. */
  reset() {
    this.times.length = this.intervals.length = this.cpu.length = 0
    this.windowStart = null
    this.calmSince = null
    this.lateAtMinimumSince = null
  }

  /**
   * Records a presented frame: `intervalMs` since the previous one and `cpuMs` of main-thread
   * work it took. Returns true when `scale` or `degraded` changed.
   */
  sample(now: number, intervalMs: number, cpuMs: number): boolean {
    this.startedAt ??= now
    if (now - this.startedAt < RENDER_SCALE.warmupMs) return false
    if (!(intervalMs >= 0) || intervalMs > RENDER_SCALE.pauseMs) {
      this.reset()
      return false
    }
    this.windowStart ??= now
    this.times.push(now)
    this.intervals.push(intervalMs)
    this.cpu.push(cpuMs)
    let expired = 0
    while (
      expired < this.times.length &&
      (this.times[expired] ?? now) < now - RENDER_SCALE.windowMs
    )
      expired++
    if (expired) {
      this.times.splice(0, expired)
      this.intervals.splice(0, expired)
      this.cpu.splice(0, expired)
    }
    if (now - this.windowStart < RENDER_SCALE.windowMs) return false
    if (now - this.changedAt < RENDER_SCALE.holdMs) return false
    if (now - this.evaluatedAt < RENDER_SCALE.evaluateMs) return false
    this.evaluatedAt = now
    const late = this.percentile(this.intervals, 0.9)
    const work = this.percentile(this.cpu, 0.5)
    const overloaded =
      late > this.budgetMs * RENDER_SCALE.overBudget && work < this.budgetMs * RENDER_SCALE.cpuBound
    if (overloaded) {
      this.calmSince = null
      const capped = this.looksCapped(late)
      const descent = this.cappedDescent
      const gained = descent !== null && late < descent.late * RENDER_SCALE.cappedGain
      if (capped && descent && !gained && this.step === 0) {
        // Even the smallest image left the frames as late: the browser or display holds the
        // rate, not the GPU. Aim for that rate instead, at the resolution it had.
        this.budgetMs = Math.max(this.budgetMs, late)
        this.cappedDescent = null
        this.lateAtMinimumSince = null
        this.change(now, descent.from)
        return true
      }
      if (!capped || gained) this.cappedDescent = null
      else if (!descent && this.step > 0) this.cappedDescent = { from: this.step, late }
      if (this.step > 0) {
        // Undoing a recent step up: wait longer before the next attempt.
        if (now - this.raisedAt < RENDER_SCALE.windowMs + RENDER_SCALE.holdMs * 2)
          this.upgradeAfter = Math.min(this.upgradeAfter * 2, RENDER_SCALE.maxUpgradeAfterMs)
        this.change(now, this.step - 1)
        return true
      }
      this.lateAtMinimumSince ??= now
      if (!this.degraded && now - this.lateAtMinimumSince >= RENDER_SCALE.degradeAfterMs) {
        this.degraded = true
        this.lateAtMinimumSince = null
        this.reset()
        this.changedAt = now
        return true
      }
      return false
    }
    this.lateAtMinimumSince = null
    this.cappedDescent = null
    if (late > this.budgetMs * RENDER_SCALE.headroom) {
      this.calmSince = null
      return false
    }
    this.calmSince ??= now
    if (this.step >= RENDER_SCALE.steps.length - 1 || now - this.calmSince < this.upgradeAfter)
      return false
    this.raisedAt = now
    this.change(now, this.step + 1)
    return true
  }

  private change(now: number, step: number) {
    this.step = step
    this.changedAt = now
    this.reset()
  }

  private percentile(values: readonly number[], p: number) {
    const scratch = this.scratch
    scratch.length = 0
    for (const value of values) scratch.push(value)
    return quantile(scratch, p)
  }
}
