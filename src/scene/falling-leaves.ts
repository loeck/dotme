import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
} from 'three/webgpu'

import type { LeafBody } from './leaf-physics'
import {
  createLeafBody,
  floatLeaf,
  LEAF_AERO,
  rotateLeaf,
  settleLeaf,
  stepLeafInAir,
} from './leaf-physics'
import { ambientGust } from './wind-field'
import type { WindGusts } from './wind-gusts'

export const LEAVES = {
  /** Leaves in the air or on the ground at once; the oldest landed one is recycled first. */
  capacity: 150,
  mobileCapacity: 48,
  /** Leaf length, metres (an oak or beech leaf), before the distance boost. */
  size: 0.1,
  /**
   * Past this distance a leaf grows with it (to the 0.9 power): a real leaf from a crown fifty
   * metres away is under a pixel, and the flecks of a gust stripping the wood vanished.
   */
  boostFrom: 14,
  /** Flat terminal fall speed, metres per second (0.8–1.6 measured for oak); sets its drag. */
  fall: [0.75, 1.35],
  /** Vortex-shedding roll (rad/s² per (m/s)²) and its rate, rad/s: each leaf rocks its own way. */
  flutter: [80, 135],
  flutterRate: [2.4, 4.2],
  /** Share of leaves driven into autorotation, and the drive over the broadside moment. */
  tumbling: 0.3,
  tumble: [1.1, 1.4],
  /** Longest integration step, seconds; low-power devices take half as many. */
  step: 1 / 60,
  lowPowerStep: 1 / 30,
  /** A cursor gust faster than this (m/s at the leaf) lifts a grounded leaf again. */
  relift: 1.8,
  /** Leaves per second a crown band sheds per metre of radius under a full cursor gust. */
  cursorRate: 2.2,
  /** Same under the ambient gust field, above `ambientThreshold`. */
  ambientRate: 0.02,
  ambientThreshold: 0.38,
  /**
   * Leaves per second per metre of crown radius that let go on their own in a full autumn,
   * whatever the gusts (more in a breeze): the wood sheds steadily rather than only in squalls.
   */
  trickleRate: 0.007,
  /** Seconds a leaf lies on the ground or the water before it fades over `fade`. */
  rest: [8, 14],
  /**
   * A floating leaf rides this far above the sampled surface, metres, plus `floatPerMetre` per
   * metre from the camera. The drawn lake is the full wave field and the GPU ripples, linearly
   * interpolated between its vertices, and its depth meets a leaf's at a grazing angle: a leaf
   * at the sampled height hid under the water and seemed to fall through it.
   */
  floatClearance: 0.008,
  floatPerMetre: 0.0012,
  /**
   * A floating leaf is drawn as if seen from at least this elevation, radians (about 24°),
   * tilting it toward the camera by at most `floatTiltMax` (about 26°).
   */
  floatTiltView: 0.42,
  floatTiltMax: 0.45,
  /** A floating leaf sinks this far, metres, while it fades. */
  sink: 0.035,
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
/** Autumn's fall: the crowns' yellows, coppers and russets, with a few late greens. */
const AUTUMN_PALETTE = [
  [0xd2a335, 0.26],
  [0xd9822b, 0.22],
  [0xb4542a, 0.16],
  [0x8f5a2c, 0.16],
  [0xa8a33e, 0.1],
  [0x7d9a40, 0.1],
] as const
/** The few dead leaves a winter gust still finds: dry browns. */
const WINTER_PALETTE = [
  [0x8f6331, 0.45],
  [0x7a5a3c, 0.35],
  [0xa07a4a, 0.2],
] as const

/** How the season changes the fall; see `seasonalLife` in `season.ts`. */
export type LeafSeason = Readonly<{
  /** Multiplier on what a gust strips. */
  rate: number
  /** 0–1 share of the autumn trickle that needs no gust. */
  trickle: number
  /** 0–1 weights of the autumn and winter palettes over the summer one. */
  autumn: number
  winter: number
}>

type Palette = readonly (readonly [number, number])[]

/** A colour from a weighted palette for a uniform `pick` in [0, 1). */
export function paletteColour(palette: Palette, pick: number) {
  let left = pick
  let hex = palette[0]?.[0] ?? 0
  for (const [value, weight] of palette) {
    hex = value
    if ((left -= weight) <= 0) break
  }
  return hex
}

/** The palette a new leaf takes in `season`, for a uniform `pick` in [0, 1). */
export function seasonPalette(season: LeafSeason, pick: number): Palette {
  if (pick < season.winter) return WINTER_PALETTE
  if (pick < season.winter + season.autumn) return AUTUMN_PALETTE
  return PALETTE
}

/** Where a falling leaf comes to rest under (x, z): its height and whether it floats. */
export type LeafGround = (x: number, z: number, fromY: number) => { y: number; water: boolean }

export type LeafWind = Readonly<{ direction: readonly [number, number]; speed: number }>

/**
 * The live lake surface under (x, z) at `time`: writes its height and slope (dh/dx, dh/dz)
 * into `out`. Without it a leaf floats on the resting level `LeafGround` reports.
 */
export type LeafWater<W extends LeafWind> = (
  x: number,
  z: number,
  time: number,
  wind: W,
  out: Float64Array,
) => void

/**
 * Takes a leaf reaching open water into the physical floaters (`FloatingBodies.catchLeaf`):
 * position, velocity, drawn width and colour. True when it was taken.
 */
export type LeafHandOff = (
  x: number,
  y: number,
  z: number,
  velocity: Readonly<{ x: number; y: number; z: number }>,
  width: number,
  colour: Color,
) => boolean

export type LeafOptions<W extends LeafWind> = Readonly<{
  water?: LeafWater<W>
  handOff?: LeafHandOff
  lowPower?: boolean
}>

const FREE = 0,
  FALLING = 1,
  GROUNDED = 2,
  FLOATING = 3

type Leaf = {
  state: number
  body: LeafBody
  size: number
  groundY: number
  water: boolean
  castX: number
  castZ: number
  /** The ground's unit normal where the leaf lies. */
  nx: number
  ny: number
  nz: number
  restUntil: number
  born: number
}

/** A blade a metre long along +Z, normal +Y, folded a little along its midrib. */
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
  for (const [x, z] of outline) positions.push(x, Math.abs(x) * 0.22, z)
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
 * Leaves torn from the crowns by gusts, the visitor's sweeps above all. Each is a light plate
 * in the air (`leaf-physics.ts`): it rocks, glides to and fro, sometimes tumbles, rides the
 * wind and the passing gusts, and lands where the Rapier statics (terrain heightfield and
 * boulder hulls) meet its path. On the ground it lies along the slope until a strong gust lifts
 * it again; on the lake it rides the live surface, slides with passing ripples, drifts
 * downwind and rings a faint ripple as it lands, then sinks a little as it fades. One
 * instanced draw, integrated on the CPU without allocating.
 */
export class FallingLeaves<W extends LeafWind = LeafWind> {
  readonly mesh: InstancedMesh<BufferGeometry, MeshStandardNodeMaterial>
  private readonly leaves: Leaf[]
  /** Crown bands that shed: x, y, z, radius. */
  private sources = new Float32Array(0)
  private readonly matrix = new Matrix4()
  private readonly quaternion = new Quaternion()
  private readonly tilt = new Quaternion()
  private readonly tiltAxis = new Vector3()
  private readonly position = new Vector3()
  private readonly scale = new Vector3()
  private readonly colour = new Color()
  private readonly push: [number, number] = [0, 0]
  private readonly surface = new Float64Array(3)
  private lastRipple = -Infinity
  private alive = 0
  private season: LeafSeason = { rate: 1, trickle: 0, autumn: 0, winter: 0 }

  private readonly camera: Vector3
  private readonly ground: LeafGround
  private readonly onWater: (x: number, z: number) => void
  private readonly random: () => number
  private readonly water: LeafWater<W> | undefined
  private readonly handOff: LeafHandOff | undefined
  private readonly velocity = { x: 0, y: 0, z: 0 }
  private readonly maxStep: number

  constructor(
    capacity: number,
    camera: Vector3,
    ground: LeafGround,
    onWater: (x: number, z: number) => void = () => {},
    random: () => number = Math.random,
    options: LeafOptions<W> = {},
  ) {
    this.camera = camera
    this.ground = ground
    this.onWater = onWater
    this.random = random
    this.water = options.water
    this.handOff = options.handOff
    this.maxStep = options.lowPower ? LEAVES.lowPowerStep : LEAVES.step
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
      state: FREE,
      body: createLeafBody(),
      size: 0,
      groundY: 0,
      water: false,
      castX: 0,
      castZ: 0,
      nx: 0,
      ny: 1,
      nz: 0,
      restUntil: 0,
      born: 0,
    }))
    this.matrix.makeScale(0, 0, 0)
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, this.matrix)
      this.mesh.setColorAt(i, this.colour.setHex(PALETTE[0][0]))
    }
  }

  setSeason(season: LeafSeason) {
    this.season = season
  }

  /** Leaves in the air, on the ground or afloat. */
  get count() {
    return this.alive
  }

  /** Leaves afloat on the lake. */
  get floating() {
    let count = 0
    for (const leaf of this.leaves) if (leaf.state === FLOATING) count++
    return count
  }

  /** Leaves lying on the ground. */
  get grounded() {
    let count = 0
    for (const leaf of this.leaves) if (leaf.state === GROUNDED) count++
    return count
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
  update(time: number, dt: number, wind: W, breeze: number, gusts: WindGusts | undefined) {
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
      if (leaf) leaf.state = FREE
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

  private shed(time: number, dt: number, wind: W, breeze: number, gusts?: WindGusts) {
    const sources = this.sources
    if (sources.length === 0) return
    const [dx, dz] = wind.direction
    const cursor = gusts?.active() ?? false
    const ambientScale = breeze * 0.6 + 0.5
    const { rate: seasonRate, trickle } = this.season
    const trickleRate = LEAVES.trickleRate * trickle * (breeze * 0.8 + 0.4)
    for (let i = 0; i + 3 < sources.length; i += 4) {
      const x = sources[i] ?? 0,
        y = sources[i + 1] ?? 0,
        z = sources[i + 2] ?? 0,
        r = sources[i + 3] ?? 0
      let rate = 0
      if (cursor && gusts) rate += LEAVES.cursorRate * r * gusts.pushAt(x, z, this.push)
      const ambient = ambientGust(x, z, time, dx, dz) * ambientScale
      if (ambient > LEAVES.ambientThreshold)
        rate += LEAVES.ambientRate * r * (ambient - LEAVES.ambientThreshold)
      rate = rate * seasonRate + trickleRate * r
      if (rate > 0 && this.random() < rate * dt) this.spawn(x, y, z, r, time)
    }
  }

  private between(range: readonly [number, number]) {
    return range[0] + (range[1] - range[0]) * this.random()
  }

  private spawn(x: number, y: number, z: number, r: number, time: number) {
    const slot = this.free()
    const leaf = this.leaves[slot]
    if (!leaf) return
    const random = this.random
    const body = leaf.body
    const angle = random() * Math.PI * 2
    const reach = r * (0.45 + 0.45 * random())
    body.x = x + Math.cos(angle) * reach
    body.z = z + Math.sin(angle) * reach
    body.y = y - r * 0.2 * random()
    body.vx = body.vy = body.vz = 0
    body.qx = body.qy = body.qz = 0
    body.qw = 1
    rotateLeaf(body, 0, 1, 0, random() * Math.PI * 2)
    // Torn off at an angle, with a small twist from the twig.
    const tilt = random() * Math.PI * 2
    rotateLeaf(body, Math.cos(tilt), 0, Math.sin(tilt), 0.3 + 0.6 * random())
    body.wx = (random() - 0.5) * 2
    body.wy = (random() - 0.5) * 2.2
    body.wz = (random() - 0.5) * 2
    const fall = this.between(LEAVES.fall)
    body.normalDrag = LEAF_AERO.gravity / (fall * fall)
    body.flutter = this.between(LEAVES.flutter)
    body.flutterRate = this.between(LEAVES.flutterRate)
    body.phase = random() * Math.PI * 2
    body.tumble =
      random() < LEAVES.tumbling
        ? LEAF_AERO.broadside * this.between(LEAVES.tumble) * (random() < 0.5 ? -1 : 1)
        : 0
    const distance = Math.hypot(
      body.x - this.camera.x,
      body.y - this.camera.y,
      body.z - this.camera.z,
    )
    leaf.size =
      LEAVES.size * (0.8 + 0.4 * random()) * Math.max(1, distance / LEAVES.boostFrom) ** 0.9
    leaf.born = time
    leaf.state = FALLING
    this.cast(leaf)
    // A summer leaf draws one number, as before seasons; other seasons draw the palette first.
    const seasonal = this.season.autumn + this.season.winter > 0
    const palette = seasonal ? seasonPalette(this.season, random()) : PALETTE
    const hex = paletteColour(palette, random())
    this.mesh.setColorAt(slot, this.colour.setHex(hex))
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.alive++
  }

  /** A free slot, else the resting leaf closest to fading out; -1 while all are falling. */
  private free() {
    let oldest = -1
    for (let i = 0; i < this.leaves.length; i++) {
      const leaf = this.leaves[i]
      if (!leaf || leaf.state === FREE) return i
      if (
        leaf.state !== FALLING &&
        (oldest < 0 || leaf.restUntil < (this.leaves[oldest]?.restUntil ?? 0))
      )
        oldest = i
    }
    if (oldest >= 0) this.alive--
    return oldest
  }

  /** Casts the ground under the leaf against the Rapier statics. */
  private cast(leaf: Leaf) {
    const { x, y, z } = leaf.body
    const ground = this.ground(x, z, y + 0.3)
    leaf.groundY = ground.y
    leaf.water = ground.water
    leaf.castX = x
    leaf.castZ = z
  }

  private land(leaf: Leaf, time: number) {
    const body = leaf.body
    leaf.restUntil = time + this.between(LEAVES.rest)
    if (leaf.water) {
      leaf.state = FLOATING
      body.wy *= 0.4
      if (time - this.lastRipple > LEAVES.rippleSpacing) {
        this.lastRipple = time
        this.onWater(body.x, body.z)
      }
      return
    }
    leaf.state = GROUNDED
    // The slope it lies on, from two more casts beside it.
    const { x, z } = body
    const from = leaf.groundY + 0.6
    const east = this.ground(x + 0.15, z, from).y - leaf.groundY
    const south = this.ground(x, z + 0.15, from).y - leaf.groundY
    const sx = Math.abs(east) < 0.3 ? -east / 0.15 : 0,
      sz = Math.abs(south) < 0.3 ? -south / 0.15 : 0
    const length = Math.hypot(sx, 1, sz)
    leaf.nx = sx / length
    leaf.ny = 1 / length
    leaf.nz = sz / length
    body.y = leaf.groundY + 0.012
    body.vx = body.vy = body.vz = 0
    body.wx = body.wy = body.wz = 0
  }

  /**
   * Lifts a floating leaf's face toward the camera when drawn. Flat on the water it is seen
   * almost edge-on from the bank: a 10 cm leaf 30 m away was under a pixel tall and seemed to
   * vanish into the lake as it landed. Ripples tilt real floating leaves too.
   */
  private tiltTowardCamera(x: number, y: number, z: number): number {
    const camera = this.camera
    const toX = camera.x - x,
      toZ = camera.z - z
    const across = Math.hypot(toX, toZ)
    if (across < 1e-3) return 0
    const elevation = Math.atan2(camera.y - y, across)
    const angle = Math.min(LEAVES.floatTiltMax, Math.max(0, LEAVES.floatTiltView - elevation))
    if (angle <= 0) return 0
    // Rotating about up × (toward the camera) turns the leaf's face toward the camera.
    this.tiltAxis.set(toZ / across, 0, -toX / across)
    this.quaternion.premultiply(this.tilt.setFromAxisAngle(this.tiltAxis, angle))
    return angle
  }

  /** Gives a leaf touching open water to the physical floaters; frees it here when taken. */
  private handToWater(leaf: Leaf, index: number, time: number) {
    const handOff = this.handOff
    if (!handOff) return false
    const body = leaf.body
    this.mesh.getColorAt(index, this.colour)
    this.velocity.x = body.vx
    this.velocity.y = body.vy
    this.velocity.z = body.vz
    if (!handOff(body.x, body.y, body.z, this.velocity, leaf.size, this.colour)) return false
    leaf.state = FREE
    if (time - this.lastRipple > LEAVES.rippleSpacing) {
      this.lastRipple = time
      this.onWater(body.x, body.z)
    }
    return true
  }

  /** How far above the sampled lake surface a leaf floats so it is drawn on it. */
  private clearance(leaf: Leaf) {
    const { x, y, z } = leaf.body
    const camera = this.camera
    // The blade's fold: lying on its back, its edges hang this far below its midrib.
    const fold = leaf.size * 0.27 * 0.22
    return (
      LEAVES.floatClearance +
      fold +
      Math.hypot(x - camera.x, y - camera.y, z - camera.z) * LEAVES.floatPerMetre
    )
  }

  private move(time: number, dt: number, wind: W, breeze: number, gusts?: WindGusts) {
    const [dx, dz] = wind.direction
    const cursor = gusts?.active() ?? false
    const steps = Math.ceil(dt / this.maxStep - 1e-6)
    const h = dt / steps
    const surface = this.surface
    let alive = 0
    for (let i = 0; i < this.leaves.length; i++) {
      const leaf = this.leaves[i]
      if (!leaf || leaf.state === FREE) continue
      const body = leaf.body
      let pushX = 0,
        pushZ = 0
      if (cursor && gusts && gusts.pushAt(body.x, body.z, this.push) > 0) {
        pushX = this.push[0] * 7
        pushZ = this.push[1] * 7
      }
      let scale = leaf.size
      if (leaf.state === GROUNDED && Math.hypot(pushX, pushZ) > LEAVES.relift) {
        // A sweep skims the litter: the leaf lifts and flies again.
        leaf.state = FALLING
        body.vx = pushX * 0.5
        body.vz = pushZ * 0.5
        body.vy = 0.8 + this.random() * 1.2
        body.wx = (this.random() - 0.5) * 8
        body.wz = (this.random() - 0.5) * 8
      }
      if (leaf.state === FALLING) {
        // The air: the breeze, the gust patch the leaf is in and any cursor gust passing it,
        // which also tosses leaves upward a little.
        const gust = ambientGust(body.x, body.z, time, dx, dz) * (breeze * 0.6 + 0.5)
        const drift = Math.min(wind.speed, 8) * 0.3 + breeze * 0.8 + gust * 2.2
        const airX = dx * drift + pushX,
          airZ = dz * drift + pushZ,
          airY = Math.hypot(pushX, pushZ) * 0.25
        let handed = false
        for (let s = 0; s < steps && leaf.state === FALLING; s++) {
          stepLeafInAir(body, airX, airY, airZ, time + s * h, h)
          const moved = Math.abs(body.x - leaf.castX) + Math.abs(body.z - leaf.castZ)
          if (moved > 1.2 || (moved > 0.3 && body.y - leaf.groundY < 0.8)) this.cast(leaf)
          let floor = leaf.groundY
          if (leaf.water && this.water && body.y - floor < 0.5) {
            this.water(body.x, body.z, time, wind, surface)
            floor = surface[0] ?? floor
          }
          if (leaf.water) floor += this.clearance(leaf)
          if (body.y <= floor + 0.01) {
            body.y = leaf.water ? floor : floor + 0.004
            if (leaf.water && this.handToWater(leaf, i, time)) {
              handed = true
              break
            }
            this.land(leaf, time)
          }
        }
        if (handed) {
          this.mesh.setMatrixAt(i, this.matrix.makeScale(0, 0, 0))
          continue
        }
      } else if (leaf.state === GROUNDED) {
        settleLeaf(body, leaf.nx, leaf.ny, leaf.nz, 1 - Math.exp(-dt * 14))
      } else {
        let level = leaf.groundY,
          slopeX = 0,
          slopeZ = 0
        if (this.water) {
          this.water(body.x, body.z, time, wind, surface)
          level = surface[0] ?? level
          slopeX = surface[1] ?? 0
          slopeZ = surface[2] ?? 0
        }
        const wet = Math.min(wind.speed, 10) * 0.012 + 0.04
        floatLeaf(
          body,
          level + this.clearance(leaf),
          slopeX,
          slopeZ,
          dx * wet + pushX * 0.08,
          dz * wet + pushZ * 0.08,
          dt,
        )
        if (Math.abs(body.x - leaf.castX) + Math.abs(body.z - leaf.castZ) > 0.6) {
          this.cast(leaf)
          // Washed against the bank: it strands there.
          if (!leaf.water) {
            body.y = leaf.groundY + 0.004
            this.land(leaf, time)
          }
        }
      }
      if (leaf.state !== FALLING) {
        const left = leaf.restUntil + LEAVES.fade - time
        if (left <= 0) {
          leaf.state = FREE
          this.mesh.setMatrixAt(i, this.matrix.makeScale(0, 0, 0))
          continue
        }
        const fading = Math.min(1, left / LEAVES.fade)
        scale *= fading
        if (leaf.state === FLOATING) body.y -= LEAVES.sink * (1 - fading)
      }
      alive++
      this.position.set(body.x, body.y, body.z)
      this.quaternion.set(body.qx, body.qy, body.qz, body.qw)
      // Raised by the half-width the tilt dips its near edge, so that edge stays above the water.
      if (leaf.state === FLOATING)
        this.position.y += (scale / 2) * Math.sin(this.tiltTowardCamera(body.x, body.y, body.z))
      this.matrix.compose(this.position, this.quaternion, this.scale.setScalar(scale))
      this.mesh.setMatrixAt(i, this.matrix)
    }
    this.alive = alive
    this.mesh.visible = alive > 0
    this.mesh.instanceMatrix.needsUpdate = true
  }
}
