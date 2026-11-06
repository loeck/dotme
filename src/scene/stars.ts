import {
  asin,
  atan,
  clamp,
  dot,
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

import { horizonNoise } from './distant-horizon'

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

/** Meteors in a wish, and seconds from one to the next (each lives about 1.15 s). */
const WISH_METEORS = 3
const WISH_SPACING = 1.2

/** Counts only active, visible night seconds. Missed/covered attempts never queue. */
export class ShootingStars {
  private readonly random: () => number
  remaining: number
  age = 2
  attempts = 0
  readonly start = new Vector3()
  readonly end = new Vector3()
  /** Meteors still due from a wish, and the screen point (NDC) they fall from. */
  private wishes = 0
  private readonly wishFrom = { x: 0, y: 0 }
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
      this.wishes = 0
      return
    }
    const delta = Math.max(0, dt)
    this.age += delta
    if (starVisibility(sunHeight) < 0.95 || covered) {
      this.age = 2
      this.wishes = 0
      return
    }
    if (this.wishes > 0) {
      // One wish meteor at a time: the next leaves once the last has burnt out.
      if (this.age < WISH_SPACING) return
      this.wishes--
      this.launch(
        this.wishFrom.x + (this.random() - 0.5) * 0.12,
        this.wishFrom.y + (this.random() - 0.5) * 0.08,
        camera,
      )
      return
    }
    this.remaining -= delta
    if (this.remaining > 0) return
    this.remaining = this.interval()
    this.attempts++
    // Upper third of the current frustum, comfortably above distant relief.
    this.launch((this.random() - 0.5) * 0.9, 0.45 + this.random() * 0.3, camera)
  }

  /**
   * A wish made on the night sky at a screen point (NDC): a short run of meteors falls from
   * there, one after another. Ignored while a wish is still falling.
   */
  wish(x: number, y: number, count = WISH_METEORS) {
    if (this.wishes > 0 || !Number.isFinite(x + y)) return false
    this.wishFrom.x = Math.max(-0.9, Math.min(0.9, x))
    this.wishFrom.y = Math.max(-0.2, Math.min(0.9, y))
    this.wishes = count
    this.age = Math.max(this.age, WISH_SPACING)
    return true
  }

  private launch(x: number, y: number, camera: PerspectiveCamera) {
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
const skyPoint = (azimuth: number, elevation: number) =>
  new Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    -Math.cos(azimuth) * Math.cos(elevation),
  )
/**
 * The galactic plane as a great circle rising from the left bank's horizon to the top of the
 * frame left of centre, so on a desktop frame the band crosses the left half diagonally and
 * passes beside the moon at midnight rather than through it. `GALAXY_FRONT` points along the band
 * into the frame and the along-band angle wraps behind the camera, where its seam is unseen.
 */
const GALAXY_LOW = skyPoint(-0.62, 0.07)
const GALAXY_NORMAL = new Vector3().crossVectors(GALAXY_LOW, skyPoint(-0.08, 0.6)).normalize()
const GALAXY_FRONT = GALAXY_LOW.clone()
  .addScaledVector(GALAXY_NORMAL, -GALAXY_LOW.dot(GALAXY_NORMAL))
  .normalize()
const GALAXY_SIDE = new Vector3().crossVectors(GALAXY_NORMAL, GALAXY_FRONT)
const constant = (v: Vector3) => vec3(v.x, v.y, v.z)

/**
 * The Milky Way: a soft band of unresolved stars, mottled by star clouds and split by a dark
 * dust rift along its core, warm at its centre and bluer at its edges. It comes out only once
 * the faintest stars have, fades near the horizon and washes out close to the moon.
 */
export function milkyWay(direction: Node<'vec3'>, moonAngle: Node<'float'>, u: StarUniforms) {
  const across = dot(direction, constant(GALAXY_NORMAL))
  const along = atan(dot(direction, constant(GALAXY_SIDE)), dot(direction, constant(GALAXY_FRONT)))
  const core = exp(across.div(0.1).pow2().negate())
  const wide = exp(across.div(0.24).pow2().negate())
  const cloudCoord = vec2(along.mul(9), across.mul(24)).add(u.uSeed)
  const starClouds = horizonNoise(cloudCoord)
    .mul(0.65)
    .add(horizonNoise(cloudCoord.mul(2.3).add(5.1)).mul(0.35))
  const rift = smoothstep(
    0.5,
    0.78,
    horizonNoise(vec2(along.mul(16), across.mul(46)).add(u.uSeed.add(17))),
  )
    .mul(exp(across.div(0.05).pow2().negate()))
    .mul(0.45)
  // Unresolved stars: a fine powder, densest in the bright star clouds, so the band reads as
  // stars rather than as a smooth haze. Each grain is a few pixels and never moves, so it
  // cannot shimmer.
  const grain = smoothstep(
    0.8,
    0.97,
    horizonNoise(vec2(along.mul(260), across.mul(260)).add(u.uSeed.mul(7))),
  )
  const density = core
    .mul(starClouds.mul(0.9).add(0.35))
    .add(wide.mul(0.28))
    .mul(rift.oneMinus())
    .mul(grain.mul(starClouds).mul(2.5).add(0.7))
  const visibility = smoothstep(
    0,
    NIGHT_FADE,
    u.uSunDirection.y.negate().sub(NIGHT_START).sub(FAINT_DELAY),
  )
  const colour = mix(vec3(0.55, 0.68, 1), vec3(1, 0.85, 0.66), core.mul(starClouds))
  return colour
    .mul(density)
    .mul(0.035)
    .mul(visibility)
    .mul(smoothstep(0.03, 0.3, direction.y))
    .mul(mix(0.45, 1, smoothstep(0.05, 0.6, moonAngle)))
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
  const brightness = random.z.pow(4.5)
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
    .mul(brightness.mul(0.38).add(0.01))
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
