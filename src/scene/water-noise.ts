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
