import { clamp, normalize, smoothstep, texture, vec2 } from 'three/tsl'
import { DataTexture, LinearFilter, RedFormat } from 'three/webgpu'
import type { Node } from 'three/webgpu'

/** Seconds for a fully open passage to close again. */
const SKY_TRACE_LIFETIME = 3
const BRUSH_OUTER_ANGLE = 0.036
const BRUSH_INNER = Math.cos(0.012)
const BRUSH_OUTER = Math.cos(BRUSH_OUTER_ANGLE)

type Direction = Readonly<{ x: number; y: number; z: number }>

/** The same stereographic aperture is used by the sky and ground lighting. */
export function skyTraceSample(direction: Node<'vec3'>, trace: ReturnType<typeof texture<'vec4'>>) {
  const ray = normalize(direction)
  const uv = ray.xz.div(ray.y.add(1)).mul(0.5).add(0.5)
  return trace.sample(clamp(uv, vec2(0.001), vec2(0.999))).r.mul(smoothstep(0, 0.04, ray.y))
}

/** A camera-independent trace on the upper hemisphere, in stereographic coordinates.
 * Every texel heals on its own clock, so older passages close while new ones stay open. */
export class SkyCursorTrace {
  readonly texture: DataTexture
  private readonly resolution: number
  private readonly pixels: Uint8Array
  private previous: Direction | null = null
  private decayRemainder = 0
  // Inclusive texel rows/columns that may hold non-zero values; empty when top > bottom.
  private top = 0
  private bottom = -1
  private left = 0
  private right = -1

  constructor(resolution = 512) {
    this.resolution = resolution
    this.pixels = new Uint8Array(resolution * resolution)
    this.texture = new DataTexture(this.pixels, resolution, resolution, RedFormat)
    this.texture.minFilter = this.texture.magFilter = LinearFilter
    this.texture.needsUpdate = true
  }

  /** A null direction ends the stroke, so an invalid pointer cannot bridge two sky visits. */
  update(direction: Direction | null, dt: number, strength = 1) {
    const healed = this.heal(dt)
    if (!direction || direction.y <= 0 || strength <= 0) {
      this.previous = null
      if (healed) this.texture.needsUpdate = true
      return
    }
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
    const steps = previous ? Math.max(1, Math.ceil(Math.acos(dot) / 0.01)) : 1
    for (let i = previous ? 1 : 0; i <= steps; i++) {
      const t = i / steps
      const x = previous ? previous.x * (1 - t) + direction.x * t : direction.x
      const y = previous ? previous.y * (1 - t) + direction.y * t : direction.y
      const z = previous ? previous.z * (1 - t) + direction.z * t : direction.z
      const length = Math.hypot(x, y, z)
      this.stamp(x / length, y / length, z / length, strength)
    }
    this.previous = { x: direction.x, y: direction.y, z: direction.z }
    this.texture.needsUpdate = true
  }

  clear() {
    this.previous = null
    this.decayRemainder = 0
    if (this.top > this.bottom) return
    this.pixels.fill(0)
    this.top = this.left = 0
    this.bottom = this.right = -1
    this.texture.needsUpdate = true
  }

  /** Lowers every open texel by its share of the lifetime; returns whether anything changed. */
  private heal(dt: number) {
    if (this.top > this.bottom) {
      this.decayRemainder = 0
      return false
    }
    this.decayRemainder += (Math.max(0, dt) * 255) / SKY_TRACE_LIFETIME
    const decay = Math.floor(this.decayRemainder)
    if (decay === 0) return false
    this.decayRemainder -= decay
    const size = this.resolution
    let open = false
    for (let row = this.top; row <= this.bottom; row++)
      for (
        let index = row * size + this.left, end = row * size + this.right;
        index <= end;
        index++
      ) {
        const value = this.pixels[index] ?? 0
        if (value === 0) continue
        const next = value > decay ? value - decay : 0
        this.pixels[index] = next
        if (next) open = true
      }
    if (!open) {
      this.top = this.left = 0
      this.bottom = this.right = -1
    }
    return true
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
    if (this.top > this.bottom) {
      this.top = top
      this.bottom = bottom
      this.left = left
      this.right = right
    } else {
      this.top = Math.min(this.top, top)
      this.bottom = Math.max(this.bottom, bottom)
      this.left = Math.min(this.left, left)
      this.right = Math.max(this.right, right)
    }
    for (let row = top; row <= bottom; row++) {
      const q = (2 * (row + 0.5)) / size - 1
      for (let col = left; col <= right; col++) {
        const p = (2 * (col + 0.5)) / size - 1
        const inverse = 1 / (1 + p * p + q * q)
        const dot = (2 * p * x + (1 - p * p - q * q) * y + 2 * q * z) * inverse
        // Warp only the rim. The center stays solid, while the contour follows
        // small cloud-like variations instead of a perfectly circular brush.
        const irregularity =
          0.78 + 0.12 * Math.sin(p * 173 + q * 91) + 0.1 * Math.sin(p * 311 - q * 247)
        const outer = BRUSH_OUTER + (BRUSH_INNER - BRUSH_OUTER) * (1 - irregularity) * 0.5
        if (dot <= outer) continue
        const edge = Math.min(1, Math.max(0, (dot - outer) / (BRUSH_INNER - outer)))
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
