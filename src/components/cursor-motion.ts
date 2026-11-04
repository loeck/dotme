/** Time constant of the trailing point that measures motion, in milliseconds. */
export const CURSOR_LAG_MS = 42
/** Extra length of the point at full speed (1 = twice as long). */
const MAX_EXTRA_STRETCH = 1.1
/** Trail length, in CSS pixels, that gives about 63% of the extra stretch. */
const STRETCH_TRAIL = 34
/** The trail is considered settled below this distance, in CSS pixels. */
const REST = 0.05

/**
 * The visible point is pinned to the pointer; a trailing point follows it with an
 * exponential lag. Their separation is the pointer velocity times the lag at steady
 * speed, eases out on its own when the mouse stops, and turns continuously when the
 * pointer reverses instead of flipping. Only frames advance the trail, so the event
 * rate cannot matter, and the pointer is taken to move linearly between two frames,
 * which makes a steady speed give the same trail at 60 Hz and 144 Hz.
 */
export class CursorMotion {
  x = 0
  y = 0
  private trailX = 0
  private trailY = 0
  private frameX = 0
  private frameY = 0
  private placed = false

  /** Pins the pointer. The first sample after a reset starts at rest. */
  moveTo(x: number, y: number) {
    this.x = x
    this.y = y
    if (this.placed) return
    this.placed = true
    this.settle()
  }

  reset() {
    this.placed = false
    this.settle()
  }

  /** Advances the trail by `dt` milliseconds; returns whether it is still moving. */
  step(dt: number): boolean {
    if (dt > 0) {
      // Exact response of the lag to a linear ramp from the previous frame's position.
      const decay = Math.exp(-dt / CURSOR_LAG_MS)
      const lead = CURSOR_LAG_MS / dt
      const driftX = (this.x - this.frameX) * lead
      const driftY = (this.y - this.frameY) * lead
      this.trailX = this.x - driftX + (this.trailX - this.frameX + driftX) * decay
      this.trailY = this.y - driftY + (this.trailY - this.frameY + driftY) * decay
      this.frameX = this.x
      this.frameY = this.y
    }
    if (this.trail >= REST) return true
    this.settle()
    return false
  }

  private settle() {
    this.trailX = this.frameX = this.x
    this.trailY = this.frameY = this.y
  }

  /** Separation between the pointer and its trail, in CSS pixels. */
  get trail() {
    return Math.hypot(this.x - this.trailX, this.y - this.trailY)
  }

  /**
   * Area-preserving strain for a round point of `radius` px that stretches into a
   * tail behind the motion. Its leading edge stays where it is at rest, so the
   * hit point never sits behind the drawn shape. Identity when settled.
   */
  strain(radius: number): string {
    const dx = this.x - this.trailX
    const dy = this.y - this.trailY
    const distance = Math.hypot(dx, dy)
    if (distance < REST) return 'none'
    const stretch = 1 + MAX_EXTRA_STRETCH * (1 - Math.exp(-distance / STRETCH_TRAIL))
    const squash = 1 / Math.sqrt(stretch)
    const ux = dx / distance
    const uy = dy / distance
    // Symmetric scale along the motion axis, then shift the ellipse backwards.
    const a = stretch * ux * ux + squash * uy * uy
    const b = (stretch - squash) * ux * uy
    const d = stretch * uy * uy + squash * ux * ux
    const shift = -(stretch - 1) * radius
    return `matrix(${round(a)}, ${round(b)}, ${round(b)}, ${round(d)}, ${round(shift * ux)}, ${round(shift * uy)})`
  }

  /** Offset of a lagging companion, bounded so it never detaches from the point. */
  lag(limit: number): string {
    const dx = this.trailX - this.x
    const dy = this.trailY - this.y
    const distance = Math.hypot(dx, dy)
    if (distance < REST) return '0 0'
    const scale = limit / (distance + limit)
    return `${round(dx * scale)}px ${round(dy * scale)}px`
  }
}

const round = (value: number) => Math.round(value * 1e4) / 1e4
