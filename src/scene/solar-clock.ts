import { required } from '../invariant'
const DAY = 86400
export const wrapDay = (seconds: number) => ((seconds % DAY) + DAY) % DAY

export function parseInitialTime(value: string | null, local = new Date()): number {
  if (value && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    const [hours, minutes] = value.split(':').map(Number)
    return required(hours) * 3600 + required(minutes) * 60
  }
  return local.getHours() * 3600 + local.getMinutes() * 60 + local.getSeconds()
}

/** Wall time, independent of the water solver's capped timestep. */
export class SolarClock {
  readonly initialSeconds: number
  readonly timeScale: number
  private readonly frozen: boolean
  private readonly startedAt: number
  constructor(
    initialSeconds: number,
    frozen = false,
    startedAt = performance.now(),
    timeScale = 1,
  ) {
    this.initialSeconds = initialSeconds
    this.frozen = frozen
    this.startedAt = startedAt
    this.timeScale = timeScale
  }

  elapsed(now = performance.now()) {
    return this.frozen ? 0 : Math.max(0, (now - this.startedAt) / 1000)
  }

  seconds(elapsed: number) {
    return wrapDay(this.initialSeconds + elapsed * this.timeScale)
  }
}
