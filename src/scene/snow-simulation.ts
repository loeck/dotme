import { required } from '../invariant'
import { deflectDrop } from './rain-simulation'
import type { RainRepulsor } from './rain-simulation'

/** Height of the ground (or the water) under a flake, metres. */
export type SnowGround = (x: number, z: number) => number
/** Extra horizontal wind at a point (the cursor's gust), m/s, written into `out`. */
export type SnowPush = (x: number, z: number, out: [number, number]) => number

export type SnowFlake = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Flake diameter, metres. */
  size: number
  seed: number
  /** Flutter phase and rate: flakes rock and spiral as they fall. */
  phase: number
  rate: number
  groundY: number
  alive: boolean
}

const SNOW = {
  /** Flakes alive at full snowfall. */
  capacity: 16000,
  mobileCapacity: 5000,
  /** Height flakes are released at, metres above the water. */
  top: 14,
  /** Terminal speed of a falling flake, m/s (aggregates fall at about 0.5–1.5 m/s). */
  fall: [0.65, 1.35],
  /** Share of the weather's wind the flakes ride; they lag it by `response` seconds. */
  windShare: 0.85,
  response: 0.7,
  /** Cursor gusts carry flakes this many m/s per unit of push. */
  gust: 5,
  /** Horizontal flutter, m/s. */
  flutter: 0.32,
} as const

/**
 * Slow, drifting snowfall in world space: flakes released over the view ride the wind with a
 * lag, flutter, swerve round the cursor's dry pocket and ride its gusts like the rain, and simply
 * vanish when they reach the ground or the lake (no splashes, no ripples).
 */
export class SnowSimulation {
  readonly flakes: SnowFlake[]
  intensity = 0
  private wind = { x: 0, z: 0 }
  private emission = 0
  private cursor = 0
  private randomState: number
  private repulsor: RainRepulsor | null = null
  private push: SnowPush | undefined
  private readonly pushed: [number, number] = [0, 0]
  private readonly ground: SnowGround
  private readonly lifetime: number
  time = 0

  constructor(ground: SnowGround, mobile: boolean, seed: number) {
    this.ground = ground
    this.randomState = (seed ^ 0x5eed_f1a6) >>> 0
    const capacity = mobile ? SNOW.mobileCapacity : SNOW.capacity
    this.flakes = Array.from({ length: capacity }, () => ({
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      size: 0,
      seed: 0,
      phase: 0,
      rate: 0,
      groundY: 0,
      alive: false,
    }))
    this.lifetime = SNOW.top / ((SNOW.fall[0] + SNOW.fall[1]) / 2)
  }

  /** Flakes born per second at full snowfall, so `capacity` are alive in steady state. */
  get rate() {
    return this.flakes.length / this.lifetime
  }

  setState(intensity: number, windX: number, windZ: number) {
    this.intensity = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0
    this.wind.x = Number.isFinite(windX) ? Math.max(-12, Math.min(12, windX)) * SNOW.windShare : 0
    this.wind.z = Number.isFinite(windZ) ? Math.max(-12, Math.min(12, windZ)) * SNOW.windShare : 0
    if (this.intensity === 0) {
      for (const flake of this.flakes) flake.alive = false
      this.emission = 0
    }
  }

  setRepulsor(repulsor: RainRepulsor | null) {
    this.repulsor = repulsor
  }

  setPush(push: SnowPush | undefined) {
    this.push = push
  }

  private random() {
    this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0
    return this.randomState / 0x100000000
  }

  private spawn(flake: SnowFlake, age = 0) {
    // Mostly small flakes with a few large aggregates; bigger ones fall a little faster.
    const size = this.random() ** 2
    flake.size = 0.006 + size * 0.016
    flake.vy = -(
      SNOW.fall[0] +
      (SNOW.fall[1] - SNOW.fall[0]) * (0.35 * size + 0.65 * this.random())
    )
    flake.vx = this.wind.x
    flake.vz = this.wind.z
    const flight = SNOW.top / -flake.vy
    // The same view-shaped release as the rain: dense near the camera, wide far away.
    const landingZ = 15 - this.random() ** 2 * 95
    const width = Math.min(96, Math.max(22, (16 - landingZ) * 1.2 + 16))
    const landingX = (this.random() - 0.5) * width
    flake.x = landingX - flake.vx * flight
    flake.z = landingZ - flake.vz * flight
    flake.y = SNOW.top
    flake.seed = this.random()
    flake.phase = this.random() * Math.PI * 2
    flake.rate = 0.8 + this.random() * 1.6
    flake.groundY = this.ground(landingX, landingZ)
    flake.alive = true
    if (age > 0) {
      flake.x += flake.vx * age
      flake.y += flake.vy * age
      flake.z += flake.vz * age
    }
  }

  /** Fill the air with a steady fall at the current intensity, as if it had been snowing. */
  prime() {
    const count = Math.min(this.flakes.length, Math.round(this.flakes.length * this.intensity))
    for (let i = 0; i < count; i++) {
      const flake = required(this.flakes[i])
      this.spawn(flake, this.random() * this.lifetime)
      if (flake.y <= flake.groundY) flake.alive = false
    }
    this.cursor = count % this.flakes.length
  }

  update(delta: number) {
    if (this.intensity === 0 || !Number.isFinite(delta) || delta <= 0) return
    const dt = Math.min(delta, 0.1)
    this.time += dt
    this.emission += this.intensity * this.rate * dt
    let searched = 0
    while (this.emission >= 1 && searched < this.flakes.length) {
      const flake = required(this.flakes[this.cursor])
      this.cursor = (this.cursor + 1) % this.flakes.length
      searched++
      if (flake.alive) continue
      this.spawn(flake)
      this.emission--
    }
    this.emission %= 1
    const response = 1 - Math.exp(-dt / SNOW.response)
    for (const flake of this.flakes) {
      if (!flake.alive) continue
      let targetX = this.wind.x,
        targetZ = this.wind.z
      if (this.push && this.push(flake.x, flake.z, this.pushed) > 1e-4) {
        targetX += this.pushed[0] * SNOW.gust
        targetZ += this.pushed[1] * SNOW.gust
      }
      flake.vx += (targetX - flake.vx) * response
      flake.vz += (targetZ - flake.vz) * response
      const swing = this.time * flake.rate + flake.phase
      const flutter = SNOW.flutter * (0.6 + flake.seed * 0.8)
      flake.x += (flake.vx + Math.cos(swing) * flutter) * dt
      flake.z += (flake.vz + Math.sin(swing * 0.83) * flutter) * dt
      flake.y += flake.vy * (1 + 0.18 * Math.sin(swing * 1.7)) * dt
      if (this.repulsor) deflectDrop(flake, this.repulsor)
      if (flake.y > flake.groundY) continue
      // Gusts move flakes off their predicted landing: check the ground where they really are.
      flake.groundY = this.ground(flake.x, flake.z)
      if (flake.y <= flake.groundY) flake.alive = false
    }
  }
}
