import { DataTexture, LinearFilter, RedFormat } from 'three/webgpu'

const SKY_TRACE_LIFETIME = 3
const BRUSH_OUTER_ANGLE = 0.25
const BRUSH_INNER = Math.cos(0.11)
const BRUSH_OUTER = Math.cos(BRUSH_OUTER_ANGLE)

type Direction = Readonly<{ x: number; y: number; z: number }>

/** A camera-independent trace on the upper hemisphere, in stereographic coordinates. */
export class SkyCursorTrace {
  readonly texture: DataTexture
  private readonly resolution: number
  private readonly pixels: Uint8Array
  private previous: Direction | null = null
  private decayRemainder = 0
  private remaining = 0

  constructor(resolution = 512) {
    this.resolution = resolution
    this.pixels = new Uint8Array(resolution * resolution)
    this.texture = new DataTexture(this.pixels, resolution, resolution, RedFormat)
    this.texture.minFilter = this.texture.magFilter = LinearFilter
    this.texture.needsUpdate = true
  }

  /** A null direction ends the stroke, so an invalid pointer cannot bridge two sky visits. */
  update(direction: Direction | null, dt: number, strength = 1) {
    let dirty = false
    if (this.remaining > 0) {
      const elapsed = Math.max(0, dt)
      this.remaining = Math.max(0, this.remaining - elapsed)
      this.decayRemainder += (elapsed * 255) / SKY_TRACE_LIFETIME
      const decay = Math.floor(this.decayRemainder)
      this.decayRemainder -= decay
      if (this.remaining === 0) {
        this.pixels.fill(0)
        this.decayRemainder = 0
        dirty = true
      } else if (decay > 0) {
        for (let i = 0; i < this.pixels.length; i++)
          this.pixels[i] = Math.max(0, (this.pixels[i] ?? 0) - decay)
        dirty = true
      }
    }
    if (direction && direction.y > 0 && strength > 0) {
      const previous = this.previous
      const dot = previous
        ? Math.max(
            -1,
            Math.min(
              1,
              previous.x * direction.x + previous.y * direction.y + previous.z * direction.z,
            ),
          )
        : 1
      const steps = previous ? Math.max(1, Math.ceil(Math.acos(dot) / 0.025)) : 1
      for (let i = previous ? 1 : 0; i <= steps; i++) {
        const t = i / steps
        const x = previous ? previous.x * (1 - t) + direction.x * t : direction.x
        const y = previous ? previous.y * (1 - t) + direction.y * t : direction.y
        const z = previous ? previous.z * (1 - t) + direction.z * t : direction.z
        const length = Math.hypot(x, y, z)
        this.stamp(x / length, y / length, z / length, strength)
      }
      this.previous = { x: direction.x, y: direction.y, z: direction.z }
      this.remaining = SKY_TRACE_LIFETIME
      dirty = true
    } else this.previous = null
    if (dirty) this.texture.needsUpdate = true
  }

  clear() {
    this.previous = null
    this.decayRemainder = 0
    if (this.remaining === 0) return
    this.pixels.fill(0)
    this.remaining = 0
    this.texture.needsUpdate = true
  }

  private stamp(x: number, y: number, z: number, strength: number) {
    const size = this.resolution
    const cx = (0.5 + x / (2 * (1 + y))) * size
    const cy = (0.5 + z / (2 * (1 + y))) * size
    // The stereographic scale is largest at the horizon. This bound contains
    // the full angular brush at every altitude.
    const reach = Math.ceil(size * Math.tan(BRUSH_OUTER_ANGLE / 2)) + 1
    const left = Math.max(0, Math.floor(cx - reach))
    const right = Math.min(size - 1, Math.ceil(cx + reach))
    const top = Math.max(0, Math.floor(cy - reach))
    const bottom = Math.min(size - 1, Math.ceil(cy + reach))
    for (let row = top; row <= bottom; row++) {
      const q = (2 * (row + 0.5)) / size - 1
      for (let col = left; col <= right; col++) {
        const p = (2 * (col + 0.5)) / size - 1
        const inverse = 1 / (1 + p * p + q * q)
        const dot = (2 * p * x + (1 - p * p - q * q) * y + 2 * q * z) * inverse
        if (dot <= BRUSH_OUTER) continue
        const edge = Math.min(1, Math.max(0, (dot - BRUSH_OUTER) / (BRUSH_INNER - BRUSH_OUTER)))
        const value = Math.round(255 * strength * edge * edge * (3 - 2 * edge))
        const index = row * size + col
        this.pixels[index] = Math.max(this.pixels[index] ?? 0, value)
      }
    }
  }

  dispose() {
    this.texture.dispose()
  }
}
