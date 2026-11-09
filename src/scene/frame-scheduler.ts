import { LOW_POWER_FPS } from './device-profile'
import type { LandscapeState } from './landscape-state'

/**
 * Paces the engine's frames: every display refresh up to the device's rate while the page has
 * focus, about 12 a second in the background, where frames sleep in a timer between draws
 * instead of waking on every refresh. Reduced motion draws only on request.
 */
export class FrameScheduler {
  /** When the next frame is due, in ms; the engine resets it when focus changes. */
  nextFrameAt = 0
  private frame = 0
  private timer = 0
  private readonly state: Readonly<LandscapeState>
  private readonly lowPower: boolean
  /** False until the scene is ready, and again once it is disposed. */
  private readonly live: () => boolean
  private readonly draw: (now: number) => void

  constructor(
    state: Readonly<LandscapeState>,
    lowPower: boolean,
    live: () => boolean,
    draw: (now: number) => void,
  ) {
    this.state = state
    this.lowPower = lowPower
    this.live = live
    this.draw = draw
  }

  request() {
    if (!this.live() || document.hidden || this.frame !== 0 || this.timer !== 0) return
    if (this.state.focused || this.state.reducedMotion) {
      this.frame = requestAnimationFrame(this.onAnimationFrame)
    } else {
      const delay = Math.max(0, this.nextFrameAt - performance.now())
      this.timer = window.setTimeout(() => {
        this.timer = 0
        if (this.live() && !document.hidden)
          this.frame = requestAnimationFrame(this.onAnimationFrame)
      }, delay)
    }
  }

  cancel() {
    cancelAnimationFrame(this.frame)
    clearTimeout(this.timer)
    this.frame = 0
    this.timer = 0
  }

  private onAnimationFrame = (now: number) => {
    this.frame = 0
    if (!this.live() || document.hidden) return
    // Leave a little room for rAF timestamp jitter at the display's nominal frequency.
    const interval = 1000 / (this.state.focused ? (this.lowPower ? LOW_POWER_FPS : 60) : 12)
    if (!this.state.reducedMotion && now < this.nextFrameAt - 0.5) {
      this.request()
      return
    }
    // Carry display jitter only in the foreground; idle frames never catch up after a delay.
    this.nextFrameAt = this.state.focused ? this.nextFrameAt + interval : now + interval
    if (this.nextFrameAt <= now) this.nextFrameAt = now + interval
    this.draw(now)
  }
}
