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
