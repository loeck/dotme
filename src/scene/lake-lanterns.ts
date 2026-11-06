import { color, mix, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl'
import { CylinderGeometry, InstancedMesh, MeshBasicNodeMaterial, Object3D } from 'three/webgpu'

import type { WindState } from './wind'

export const LANTERN = {
  /** Lanterns afloat at once; a new one past this replaces the oldest. */
  limit: 6,
  /** Drift speed per metre-per-second of wind, metres per second. */
  drift: 0.035,
  /** A second tap within this many milliseconds and CSS pixels of the first places one. */
  doubleTapMs: 350,
  doubleTapPixels: 24,
  /** Seconds a lantern takes to kindle, and to go out at dawn. */
  kindle: 1.2,
} as const

/** Whether two taps make a double tap. */
export function isDoubleTap(
  first: Readonly<{ x: number; y: number; time: number }> | null,
  second: Readonly<{ x: number; y: number; time: number }>,
) {
  return (
    first !== null &&
    second.time - first.time > 0 &&
    second.time - first.time <= LANTERN.doubleTapMs &&
    Math.hypot(second.x - first.x, second.y - first.y) <= LANTERN.doubleTapPixels
  )
}

type Lantern = { x: number; z: number; born: number; phase: number; spin: number }

/**
 * Paper lanterns set afloat on the night lake: small warm-glowing drums that drift slowly
 * downwind, bob on the waves and turn as they go. They are unlit and bright enough to bloom,
 * the lake mirror reflects them, and they go out at dawn. They light nothing around them: a
 * real light per lantern would cost too much.
 */
export class LakeLanterns {
  readonly mesh: InstancedMesh<CylinderGeometry, MeshBasicNodeMaterial>
  private readonly lanterns: Lantern[] = []
  private readonly glow = uniform(0)
  private readonly dummy = new Object3D()
  private lastTime: number | null = null

  constructor() {
    const material = new MeshBasicNodeMaterial()
    // Brightest through the middle of the paper, darker at the rims, warm as a candle.
    const height = positionLocal.y.div(0.29).add(0.5)
    const paper = smoothstep(0, 0.35, height).mul(smoothstep(1, 0.65, height))
    material.colorNode = mix(color(0x3a1a08), vec3(4.2, 1.9, 0.6), paper.mul(this.glow))
    this.mesh = new InstancedMesh(
      new CylinderGeometry(0.14, 0.17, 0.29, 10),
      material,
      LANTERN.limit,
    )
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.name = 'lake-lanterns'
  }

  get count() {
    return this.lanterns.length
  }

  /** Sets a lantern afloat at (x, z); past the limit the oldest goes. */
  place(x: number, z: number, time: number) {
    if (!Number.isFinite(x + z + time)) return
    if (this.lanterns.length >= LANTERN.limit) this.lanterns.shift()
    this.lanterns.push({
      x,
      z,
      born: time,
      phase: Math.random() * Math.PI * 2,
      spin: 0.2 + Math.random() * 0.3,
    })
  }

  clear() {
    this.lanterns.length = 0
    this.mesh.count = 0
  }

  /**
   * Drifts and bobs the lanterns at time `time`. `surface` gives the water height at a point,
   * `isWater` keeps them off the banks (one that would ground stays put), and `night` (0–1)
   * kindles them or puts them out.
   */
  update(
    time: number,
    wind: WindState,
    night: number,
    surface: (x: number, z: number) => number,
    isWater: (x: number, z: number) => boolean,
    frozen: boolean,
  ) {
    const dt =
      this.lastTime === null || frozen ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime))
    this.lastTime = time
    // Lanterns are a night thing: by full day they are gone.
    if (night <= 0.02 && this.lanterns.length > 0) this.clear()
    const speed = wind.speed * LANTERN.drift
    for (const [index, lantern] of this.lanterns.entries()) {
      const nx = lantern.x + wind.direction[0] * speed * dt,
        nz = lantern.z + wind.direction[1] * speed * dt
      if (isWater(nx, nz)) {
        lantern.x = nx
        lantern.z = nz
      }
      const y = surface(lantern.x, lantern.z)
      const age = time - lantern.born
      const dummy = this.dummy
      dummy.position.set(lantern.x, y + 0.13, lantern.z)
      dummy.rotation.set(
        Math.sin(time * 1.3 + lantern.phase) * 0.06,
        lantern.phase + time * lantern.spin,
        Math.cos(time * 1.1 + lantern.phase) * 0.06,
      )
      // Grows in from nothing as it is set down.
      dummy.scale.setScalar(Math.min(1, Math.max(0.01, age / 0.4)))
      dummy.updateMatrix()
      this.mesh.setMatrixAt(index, dummy.matrix)
    }
    this.mesh.count = this.lanterns.length
    this.mesh.instanceMatrix.needsUpdate = true
    const kindled = this.lanterns.length > 0 ? Math.min(1, Math.max(0, night)) : 0
    this.glow.value +=
      (kindled - this.glow.value) * (frozen ? 1 : 1 - Math.exp(-dt / LANTERN.kindle))
    this.mesh.visible = this.lanterns.length > 0
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
