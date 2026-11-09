import { fract, sin, vec2 } from 'three/tsl'
import type { Node } from 'three/webgpu'

/** The classic sine hash of a 2D cell, in [0, 1): `fract(sin(dot(p, (127.1, 311.7))) * 43758.5453)`. */
export const hash12 = (p: Node<'vec2'>) => fract(sin(p.dot(vec2(127.1, 311.7))).mul(43758.5453))
