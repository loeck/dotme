import {
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu'

import { ambientGust } from './wind-field'
import type { WindGusts } from './wind-gusts'

export const LEAVES = {
  /** Leaves in the air or on the ground at once; the oldest landed one is recycled first. */
  capacity: 160,
  mobileCapacity: 48,
  /** Leaf length, metres (an oak or beech leaf), before the distance boost. */
  size: 0.1,
  /**
   * Past this distance a leaf grows with it (to the 0.9 power): a real leaf from a crown fifty
   * metres away is under a pixel, and the flecks of a gust stripping the wood vanished.
   */
  boostFrom: 14,
  /** Terminal fall speed of a tumbling leaf, metres per second (0.8–1.6 measured for oak). */
  fall: [0.75, 1.35],
  /** Leaves per second a crown band sheds per metre of radius under a full cursor gust. */
  cursorRate: 2.2,
  /** Same under the ambient gust field, above `ambientThreshold`. */
  ambientRate: 0.02,
  ambientThreshold: 0.38,
  /** Seconds a leaf lies on the ground or the water before it fades over `fade`. */
  rest: [5, 9],
  fade: 1.6,
  /** Shortest time between two ripples from leaves touching the water, seconds. */
  rippleSpacing: 0.35,
} as const

/**
 * The leaves a gust tears off are the loosest: mostly paler, yellowing greens, then gold and a
 * few brown. The crowns' own dark greens vanished against them.
 */
const PALETTE = [
  [0x7da445, 0.28],
  [0x93a944, 0.22],
  [0x648f3a, 0.15],
  [0xc2a73e, 0.17],
  [0xcf8f35, 0.1],
  [0x8f6331, 0.08],
] as const

/** Where a falling leaf comes to rest under (x, z): its height and whether it floats. */
export type LeafGround = (x: number, z: number, fromY: number) => { y: number; water: boolean }

export type LeafWind = Readonly<{ direction: readonly [number, number]; speed: number }>

type Leaf = {
  /** 0 free, 1 falling, 2 resting. */
  state: number
  x: number
  y: number
  z: number
  vx: number
  vz: number
  fall: number
  phase: number
  swing: number
  swingRate: number
  spin: number
  tumble: number
  tumbleRate: number
  yaw: number
  size: number
  groundY: number
  water: boolean
  castX: number
  castZ: number
  restUntil: number
  born: number
}

/** A flat leaf blade, a metre long along +Z, normal +Y; instances scale it to size. */
function leafGeometry() {
  const outline: Array<[number, number]> = [
    [0, 0.5],
    [0.17, 0.34],
    [0.27, 0.1],
    [0.25, -0.15],
    [0.14, -0.38],
    [0, -0.5],
    [-0.14, -0.38],
    [-0.25, -0.15],
    [-0.27, 0.1],
    [-0.17, 0.34],
  ]
  const positions = [0, 0, 0]
  for (const [x, z] of outline) positions.push(x, 0, z)
  const indices: number[] = []
  for (let i = 0; i < outline.length; i++) indices.push(0, 1 + i, 1 + ((i + 1) % outline.length))
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute(
    'normal',
    new Float32BufferAttribute(
      Array.from({ length: positions.length / 3 }, () => [0, 1, 0]).flat(),
      3,
    ),
  )
  geometry.setIndex(indices)
  return geometry
}

/**
 * Leaves torn from the crowns by gusts, the visitor's sweeps above all: each flutters down,
 * swinging side to side as a real leaf does, rides the wind and the passing gusts, then lies on
 * the ground or floats on the lake for a few seconds and fades. One instanced draw, simulated on
 * the CPU: a few dozen leaves cost far less than their draw.
 */
export class FallingLeaves {
  readonly mesh: InstancedMesh<BufferGeometry, MeshStandardNodeMaterial>
  private readonly leaves: Leaf[]
  /** Crown bands that shed: x, y, z, radius. */
  private sources = new Float32Array(0)
  private readonly matrix = new Matrix4()
  private readonly quaternion = new Quaternion()
  private readonly euler = new Euler(0, 0, 0, 'YXZ')
  private readonly position = new Vector3()
  private readonly scale = new Vector3()
  private readonly colour = new Color()
  private readonly push: [number, number] = [0, 0]
  private lastRipple = -Infinity
  private alive = 0

  private readonly camera: Vector3
  private readonly ground: LeafGround
  private readonly onWater: (x: number, z: number) => void
  private readonly random: () => number

  constructor(
    capacity: number,
    camera: Vector3,
    ground: LeafGround,
    onWater: (x: number, z: number) => void = () => {},
    random: () => number = Math.random,
  ) {
    this.camera = camera
    this.ground = ground
    this.onWater = onWater
    this.random = random
    const material = new MeshStandardNodeMaterial({
      roughness: 0.82,
      metalness: 0,
      envMapIntensity: 0.4,
      side: DoubleSide,
    })
    this.mesh = new InstancedMesh(leafGeometry(), material, capacity)
    this.mesh.name = 'Falling leaves'
    // Leaves fly anywhere over the wood: no single bounding sphere fits them for long.
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.leaves = Array.from({ length: capacity }, () => ({
      state: 0,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vz: 0,
      fall: 1,
      phase: 0,
      swing: 0,
      swingRate: 0,
      spin: 0,
      tumble: 0,
      tumbleRate: 0,
      yaw: 0,
      size: 0,
      groundY: 0,
      water: false,
      castX: 0,
      castZ: 0,
      restUntil: 0,
      born: 0,
    }))
    this.matrix.makeScale(0, 0, 0)
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this.matrix)
      this.mesh.setColorAt(i, this.colour.setHex(PALETTE[0][0]))
    }
  }

  /** Leaves in the air or on the ground. */
  get count() {
    return this.alive
  }

  /** Crown pick spheres (x, y, z, radius per entry); small shrubs and stray spheres don't shed. */
  setSources(spheres: Float32Array) {
    const kept: number[] = []
    for (let i = 0; i + 3 < spheres.length; i += 4)
      if ((spheres[i + 3] ?? 0) >= 0.6) kept.push(...spheres.subarray(i, i + 4))
    this.sources = Float32Array.from(kept)
  }

  /**
   * Sheds leaves where gusts blow through the crowns and moves every leaf by `dt` seconds.
   * `breeze` is the vegetation's lean strength (0 calm to ~1.4 in a gale).
   */
  update(time: number, dt: number, wind: LeafWind, breeze: number, gusts: WindGusts | undefined) {
    if (!(dt > 0)) return
    const step = Math.min(dt, 0.1)
    this.shed(time, step, wind, breeze, gusts)
    if (this.alive === 0) {
      this.mesh.visible = false
      return
    }
    this.move(time, step, wind, breeze, gusts)
  }

  clear() {
    for (let i = 0; i < this.leaves.length; i++) {
      const leaf = this.leaves[i]
      if (leaf) leaf.state = 0
      this.mesh.setMatrixAt(i, this.matrix.makeScale(0, 0, 0))
    }
    this.alive = 0
    this.mesh.instanceMatrix.needsUpdate = true
    this.mesh.visible = false
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
  }

  private shed(time: number, dt: number, wind: LeafWind, breeze: number, gusts?: WindGusts) {
    const sources = this.sources
    if (sources.length === 0) return
    const [dx, dz] = wind.direction
    const cursor = gusts?.active(time) ?? false
    const ambientScale = breeze * 0.6 + 0.5
    for (let i = 0; i + 3 < sources.length; i += 4) {
      const x = sources[i] ?? 0,
        y = sources[i + 1] ?? 0,
        z = sources[i + 2] ?? 0,
        r = sources[i + 3] ?? 0
      let rate = 0
      if (cursor && gusts) rate += LEAVES.cursorRate * r * gusts.pushAt(x, z, time, this.push)
      const ambient = ambientGust(x, z, time, dx, dz) * ambientScale
      if (ambient > LEAVES.ambientThreshold)
        rate += LEAVES.ambientRate * r * (ambient - LEAVES.ambientThreshold)
      if (rate > 0 && this.random() < rate * dt) this.spawn(x, y, z, r, time)
    }
  }

  private spawn(x: number, y: number, z: number, r: number, time: number) {
    const slot = this.free()
    const leaf = this.leaves[slot]
    if (!leaf) return
    const random = this.random
    const angle = random() * Math.PI * 2
    const reach = r * (0.45 + 0.45 * random())
    leaf.x = x + Math.cos(angle) * reach
    leaf.z = z + Math.sin(angle) * reach
    leaf.y = y - r * 0.2 * random()
    leaf.vx = 0
    leaf.vz = 0
    leaf.fall = LEAVES.fall[0] + (LEAVES.fall[1] - LEAVES.fall[0]) * random()
    leaf.phase = random() * Math.PI * 2
    leaf.swing = 0.25 + 0.35 * random()
    leaf.swingRate = 2.4 + 1.8 * random()
    leaf.spin = (random() - 0.5) * 2.2
    // About one leaf in three tumbles end over end instead of swinging flat.
    leaf.tumbleRate = random() < 0.35 ? (4 + 4 * random()) * (random() < 0.5 ? -1 : 1) : 0
    leaf.tumble = random() * Math.PI * 2
    leaf.yaw = random() * Math.PI * 2
    const distance = Math.hypot(
      leaf.x - this.camera.x,
      leaf.y - this.camera.y,
      leaf.z - this.camera.z,
    )
    leaf.size =
      LEAVES.size * (0.8 + 0.4 * random()) * Math.max(1, distance / LEAVES.boostFrom) ** 0.9
    leaf.born = time
    leaf.state = 1
    this.cast(leaf)
    let pick = random()
    let hex: number = PALETTE[0][0]
    for (const [value, weight] of PALETTE) {
      hex = value
      if ((pick -= weight) <= 0) break
    }
    this.mesh.setColorAt(slot, this.colour.setHex(hex))
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.alive++
  }

  /** A free slot, else the resting leaf closest to fading out; -1 while all are falling. */
  private free() {
    let oldest = -1
    for (let i = 0; i < this.leaves.length; i++) {
      const leaf = this.leaves[i]
      if (!leaf || leaf.state === 0) return i
      if (
        leaf.state === 2 &&
        (oldest < 0 || leaf.restUntil < (this.leaves[oldest]?.restUntil ?? 0))
      )
        oldest = i
    }
    if (oldest >= 0) this.alive--
    return oldest
  }

  private cast(leaf: Leaf) {
    const ground = this.ground(leaf.x, leaf.z, leaf.y)
    leaf.groundY = ground.y
    leaf.water = ground.water
    leaf.castX = leaf.x
    leaf.castZ = leaf.z
  }

  private move(time: number, dt: number, wind: LeafWind, breeze: number, gusts?: WindGusts) {
    const [dx, dz] = wind.direction
    const response = 1 - Math.exp(-dt * 1.6)
    const cursor = gusts?.active(time) ?? false
    let alive = 0
    for (let i = 0; i < this.leaves.length; i++) {
      const leaf = this.leaves[i]
      if (!leaf || leaf.state === 0) continue
      let scale = leaf.size
      if (leaf.state === 1) {
        // Drift: the breeze, the gust patch the leaf is in, and any cursor gust passing it.
        const gust = ambientGust(leaf.x, leaf.z, time, dx, dz) * (breeze * 0.6 + 0.5)
        const drift = Math.min(wind.speed, 8) * 0.3 + breeze * 0.8 + gust * 2.2
        let tx = dx * drift,
          tz = dz * drift
        if (cursor && gusts && gusts.pushAt(leaf.x, leaf.z, time, this.push) > 0) {
          tx += this.push[0] * 7
          tz += this.push[1] * 7
        }
        leaf.vx += (tx - leaf.vx) * response
        leaf.vz += (tz - leaf.vz) * response
        const age = time - leaf.born
        const swing = leaf.phase + age * leaf.swingRate
        // A swinging leaf sinks fastest through the bottom of each swing and nearly hangs at
        // its ends; a tumbling one falls more steadily.
        const sink = leaf.tumbleRate === 0 ? 1 + 0.55 * Math.cos(2 * swing) : 1
        leaf.x += leaf.vx * dt
        leaf.z += leaf.vz * dt
        leaf.y -= leaf.fall * sink * dt
        leaf.yaw += leaf.spin * dt
        leaf.tumble += leaf.tumbleRate * dt
        if (Math.abs(leaf.x - leaf.castX) + Math.abs(leaf.z - leaf.castZ) > 1.5) this.cast(leaf)
        // Side-to-side swing across the leaf's heading, rolling into each turn.
        const side = Math.sin(swing) * leaf.swing
        const sx = Math.cos(leaf.yaw),
          sz = -Math.sin(leaf.yaw)
        this.position.set(leaf.x + sx * side, leaf.y, leaf.z + sz * side)
        const roll = leaf.tumbleRate === 0 ? Math.cos(swing) * 0.85 : leaf.tumble
        this.euler.set(leaf.tumbleRate === 0 ? 0.25 * Math.sin(swing * 0.5) : 0, leaf.yaw, roll)
        if (leaf.y <= leaf.groundY + 0.02) {
          // Settle where it is drawn, swing included, rather than jumping back to its track.
          leaf.state = 2
          leaf.x = this.position.x
          leaf.z = this.position.z
          leaf.y = leaf.groundY + 0.02
          leaf.restUntil = time + LEAVES.rest[0] + (LEAVES.rest[1] - LEAVES.rest[0]) * this.random()
          if (leaf.water && time - this.lastRipple > LEAVES.rippleSpacing) {
            this.lastRipple = time
            this.onWater(leaf.x, leaf.z)
          }
        }
      } else {
        // Resting: flat, a floating leaf still drifts a little downwind.
        if (leaf.water) {
          leaf.x += dx * 0.12 * dt
          leaf.z += dz * 0.12 * dt
        }
        this.position.set(leaf.x, leaf.y, leaf.z)
        this.euler.set(0, leaf.yaw, 0)
        const left = leaf.restUntil + LEAVES.fade - time
        if (left <= 0) {
          leaf.state = 0
          this.mesh.setMatrixAt(i, this.matrix.makeScale(0, 0, 0))
          continue
        }
        scale *= Math.min(1, left / LEAVES.fade)
      }
      alive++
      this.quaternion.setFromEuler(this.euler)
      this.matrix.compose(this.position, this.quaternion, this.scale.setScalar(scale))
      this.mesh.setMatrixAt(i, this.matrix)
    }
    this.alive = alive
    this.mesh.visible = alive > 0
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
