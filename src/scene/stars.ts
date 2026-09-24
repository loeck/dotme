import {
  asin,
  atan,
  clamp,
  exp,
  float,
  fract,
  fwidth,
  length,
  max,
  mix,
  sin,
  smoothstep,
  vec2,
  vec3,
} from 'three/tsl'
import type { Node } from 'three/webgpu'
import { Vector3 } from 'three/webgpu'
import type { PerspectiveCamera } from 'three/webgpu'

function starRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

// Match the end of the shared daylight fade; no stars during twilight.
const NIGHT_START = 0.12
const NIGHT_FADE = 0.16
const FAINT_DELAY = 0.06

export function starVisibility(sunHeight: number, brightness = 1) {
  const t = Math.max(
    0,
    Math.min(1, (-sunHeight - NIGHT_START - (1 - brightness) * FAINT_DELAY) / NIGHT_FADE),
  )
  return t * t * (3 - 2 * t)
}

/** Counts only active, visible night seconds. Missed/covered attempts never queue. */
export class ShootingStars {
  private readonly random: () => number
  remaining: number
  age = 2
  attempts = 0
  readonly start = new Vector3()
  readonly end = new Vector3()
  constructor(seed: number) {
    this.random = starRandom(seed ^ 0x57a25)
    this.remaining = this.interval()
  }
  private interval() {
    return 90 + this.random() * 90
  }
  advance(
    dt: number,
    sunHeight: number,
    covered: boolean,
    frozen: boolean,
    camera: PerspectiveCamera,
  ) {
    if (frozen) {
      this.age = 2
      return
    }
    const delta = Math.max(0, dt)
    this.age += delta
    if (starVisibility(sunHeight) < 0.95 || covered) {
      this.age = 2
      return
    }
    this.remaining -= delta
    if (this.remaining > 0) return
    this.remaining = this.interval()
    this.attempts++
    // Upper third of the current frustum, comfortably above distant relief.
    const x = (this.random() - 0.5) * 0.9,
      y = 0.45 + this.random() * 0.3
    const sign = this.random() > 0.5 ? 1 : -1
    this.start.set(x, y, 0.5).unproject(camera).sub(camera.position).normalize()
    this.end
      .set(x + sign * 0.24, y - 0.18, 0.5)
      .unproject(camera)
      .sub(camera.position)
      .normalize()
    this.age = 0
  }
}

export interface StarUniforms {
  uSeed: Node<'float'>
  uSunDirection: Node<'vec3'>
  uStarTime: Node<'float'>
  uMeteorStart: Node<'vec3'>
  uMeteorEnd: Node<'vec3'>
  uMeteorAge: Node<'float'>
}
function normalizeStarVector(value: Node<'vec3'>) {
  return value.div(max(length(value), 0.000001))
}

export function stellarRadiance(
  direction: Node<'vec3'>,
  moonAngle: Node<'float'>,
  u: StarUniforms,
) {
  const sky = vec2(
    atan(direction.x, direction.z.negate()).mul(31.8309886),
    asin(clamp(direction.y, -1, 1)).mul(63.6619772),
  )
  const cell = sky.floor()
  const q0 = fract(
    vec3(cell.x, cell.y, cell.x)
      .mul(vec3(0.1031, 0.103, 0.0973))
      .add(u.uSeed),
  )
  const q = q0.add(q0.dot(q0.yxz.add(33.33)))
  const random = fract(q.xxy.add(q.yzz).mul(q.zyx))
  const offset = fract(sky).sub(random.xy.mul(0.7).add(0.15))
  const brightness = random.z.pow(7)
  const visibility = smoothstep(
    0,
    NIGHT_FADE,
    u.uSunDirection.y.negate().sub(NIGHT_START).sub(brightness.oneMinus().mul(FAINT_DELAY)),
  )
  const variance = mix(0.01, 0.032, brightness).pow(2)
  const filtered = variance.add(fwidth(sky).dot(fwidth(sky)).div(12))
  const point = exp(offset.dot(offset).negate().div(filtered.mul(2)))
    .mul(variance)
    .div(filtered)
  const twinkle = sin(u.uStarTime.mul(random.y.mul(0.45).add(0.42)).add(random.x.mul(61)))
    .mul(0.055)
    .add(1)
  const horizon = smoothstep(0.025, 0.2, direction.y)
  const lunar = mix(0.15, 1, smoothstep(0.02, 0.3, moonAngle))
  const radiance = mix(vec3(0.65, 0.78, 1), vec3(1, 0.88, 0.7), random.x)
    .mul(point)
    .mul(brightness.mul(0.22).add(0.008))
    .mul(visibility)
    .mul(twinkle)
    .mul(horizon)
    .mul(lunar)
  const progress = clamp(u.uMeteorAge.div(0.85), 0, 1)
  const head = normalizeStarVector(mix(u.uMeteorStart, u.uMeteorEnd, progress))
  const tail = normalizeStarVector(mix(u.uMeteorStart, u.uMeteorEnd, max(0, progress.sub(0.19))))
  const segment = head.sub(tail)
  const along = clamp(
    direction
      .sub(tail)
      .dot(segment)
      .div(max(segment.dot(segment), 0.000001)),
    0,
    1,
  )
  const distance = length(direction.sub(normalizeStarVector(tail.add(segment.mul(along)))))
  const width = max(length(fwidth(direction)).mul(0.55), 0.00035)
  const line = exp(distance.pow(2).negate().div(width.pow(2))).mul(float(0.00035).div(width))
  const life = smoothstep(0, 0.08, u.uMeteorAge).mul(
    smoothstep(0.65, 1.15, u.uMeteorAge).oneMinus(),
  )
  return radiance.add(
    vec3(0.68, 0.8, 1)
      .mul(line)
      .mul(along)
      .mul(life)
      .mul(0.7)
      .mul(horizon)
      .mul(smoothstep(0, NIGHT_FADE, u.uSunDirection.y.negate().sub(NIGHT_START))),
  )
}
