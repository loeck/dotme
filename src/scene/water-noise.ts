import { floor, fract, mix, sin, vec2, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'

export function contactNoise(p: Node<'vec2'>) {
  const i = floor(p),
    f0 = fract(p),
    f = f0.mul(f0).mul(vec2(3).sub(f0.mul(2)))
  const corners = vec4(
    i.dot(vec2(127.1, 311.7)),
    i.add(vec2(1, 0)).dot(vec2(127.1, 311.7)),
    i.add(vec2(0, 1)).dot(vec2(127.1, 311.7)),
    i.add(1).dot(vec2(127.1, 311.7)),
  )
  const values = fract(sin(corners).mul(43758.5453))
  return mix(mix(values.x, values.y, f.x), mix(values.z, values.w, f.x), f.y)
}

/**
 * Value noise whose lattice repeats every `period` cells. Wrapping the cell
 * index keeps the hash's arguments small, so fine, fast-scrolling detail keeps
 * its precision on GPUs whose `sin` loses accuracy for large arguments.
 */
export function tiledNoise(p: Node<'vec2'>, period: number) {
  const cell = floor(p),
    f0 = fract(p),
    f = f0.mul(f0).mul(vec2(3).sub(f0.mul(2)))
  const wrap = (index: Node<'vec2'>) => index.sub(floor(index.div(period)).mul(period))
  const i0 = wrap(cell),
    i1 = wrap(cell.add(1))
  const key = vec2(127.1, 311.7)
  const corners = vec4(
    i0.dot(key),
    vec2(i1.x, i0.y).dot(key),
    vec2(i0.x, i1.y).dot(key),
    i1.dot(key),
  )
  const values = fract(sin(corners).mul(43758.5453))
  return mix(mix(values.x, values.y, f.x), mix(values.z, values.w, f.x), f.y)
}

/**
 * Value noise whose lattice repeats every `period.x` cells across and `period.y`
 * cells down. A pattern scrolled by a wrapped clock stays seamless when each axis
 * repeats after exactly the distance it scrolls in one clock period.
 */
export function loopNoise(p: Node<'vec2'>, period: [number, number]) {
  const cell = floor(p),
    f0 = fract(p),
    f = f0.mul(f0).mul(vec2(3).sub(f0.mul(2)))
  const size = vec2(...period)
  const wrap = (index: Node<'vec2'>) => index.sub(floor(index.div(size)).mul(size))
  const i0 = wrap(cell),
    i1 = wrap(cell.add(1))
  const key = vec2(127.1, 311.7)
  const corners = vec4(
    i0.dot(key),
    vec2(i1.x, i0.y).dot(key),
    vec2(i0.x, i1.y).dot(key),
    i1.dot(key),
  )
  const values = fract(sin(corners).mul(43758.5453))
  return mix(mix(values.x, values.y, f.x), mix(values.z, values.w, f.x), f.y)
}

/** Procedural waterfall patterns wrap their clock so hashed noise keeps its float precision. */
export const PATTERN_PERIOD = 600
/** Lattice cells a pattern scrolling at `rate` cells per second covers in one clock period. */
export function loopCells(rate: number) {
  const cells = rate * PATTERN_PERIOD
  const whole = Math.round(cells)
  if (Math.abs(cells - whole) > 1e-6)
    throw new Error(`pattern rate ${rate} does not loop in ${PATTERN_PERIOD} s`)
  return whole
}
/** Spatial axes never reach this many cells, so wrapping them changes nothing. */
export const OPEN_AXIS = 8192
