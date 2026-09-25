import type { RigidBody, Vector } from '@dimforge/rapier3d-compat'
import {
  attribute,
  uv,
  float,
  vec2,
  vec3,
  sin,
  cos,
  exp,
  clamp,
  smoothstep,
  fract,
  floor,
  mix,
  positionView,
  normalize,
  cross,
  dFdx,
  dFdy,
  faceDirection,
  positionLocal,
} from 'three/tsl'
import type { BufferAttribute, InterleavedBufferAttribute, Node, NodeBuilder } from 'three/webgpu'
import {
  DynamicDrawUsage,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardNodeMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import type { Scene } from 'three/webgpu'

import { required } from '../invariant'
import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex, sampleShore } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { PhysicsWorld } from './physics-world'
import { SplashImpacts } from './splash-impacts'
import { createSplashProfile } from './splash-profile'
import type { SplashProfile } from './splash-profile'
import { sampleWindField } from './water-surface'
import type { WindState } from './wind'

const hash = (q: Node<'vec2'>) => fract(sin(q.dot(vec2(127.1, 311.7))).mul(43758.5453))

const noise = (point: Node<'vec2'>) => {
  const grid = floor(point),
    f0 = fract(point),
    f = f0.mul(f0).mul(vec2(3).sub(f0.mul(2)))

  return mix(
    mix(hash(grid), hash(grid.add(vec2(1, 0))), f.x),
    mix(hash(grid.add(vec2(0, 1))), hash(grid.add(1)), f.x),
    f.y,
  )
}

class SheetMaterial extends MeshStandardNodeMaterial {
  localPosition: Node<'vec3'> | null = null
  override setupPosition(builder: NodeBuilder) {
    if (this.localPosition) positionLocal.assign(this.localPosition)
    return super.setupPosition(builder)
  }
}

type Contact = { x: number; z: number; nx: number; nz: number; armed: boolean; next: number }

const SPLASH_STEP = 1 / 60
const MAX_SPLASH_STEPS = 4
const DROP_LIFE = 1.6
const DROP_RADIUS = 0.02
const DROP_MASS = 1000 * (4 / 3) * Math.PI * DROP_RADIUS ** 3
const PARKED_Y = -100
const SETTLE_STEPS = 21
/** Droplets hit terrain but neither each other nor fish; statics keep the default groups. */
const DROPLET_GROUPS = (0x0002 << 16) | 0xfffb

type PendingDrop = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  size: number
  drag: number
  windX: number
  windZ: number
  release: number
}
/** Externally sourced droplet, e.g. a waterfall foot jet. Shared pool and stepper. */
export type SplashJet = PendingDrop
export type WaterfallImpact = Readonly<{
  x: number
  z: number
  time: number
  energy: number
}>
const RING_SAMPLES = 3
type Drop = {
  body: RigidBody
  born: number
  size: number
  drag: number
  windX: number
  windZ: number
  slowSteps: number
  /** Last step-grid samples, x/y/z/t quads; refinement brackets stay frame-rate independent. */
  ring: Float64Array
  ringCount: number
  active: boolean
}
type Sheet = {
  x: number
  y: number
  z: number
  heading: number
  born: number
  energy: number
  profile: SplashProfile
}

/** Sparse impact jets tied to the same wind-wave field as the visible surface. */
export class LakeSplashes {
  readonly mesh: InstancedMesh<SphereGeometry, MeshStandardNodeMaterial>
  readonly sheets: InstancedMesh<PlaneGeometry, MeshStandardNodeMaterial>
  readonly impacts: SplashImpacts
  readonly contacts: Contact[] = []
  readonly capacity: number
  private readonly drops: Drop[]
  private readonly pending: PendingDrop[] = []
  private readonly transform = new Object3D()
  private readonly up = new Vector3(0, 1, 0)
  private readonly velocity = new Vector3()
  private readonly dropPosition = new Vector3()
  private readonly positionTarget: Vector = { x: 0, y: 0, z: 0 }
  private readonly velocityTarget: Vector = { x: 0, y: 0, z: 0 }
  private readonly forceTarget: Vector = { x: 0, y: 0, z: 0 }
  private stepTime = 0
  private accumulator = 0
  private lastTime: number | null = null
  private readonly sheetsState: Array<Sheet | null> = Array.from({ length: 24 }, () => null)
  private sheetCursor = 0
  onReturn?: (x: number, z: number, radius: number, velocity: number) => void
  private state: number
  private nextCheck = 0
  private cursor = 0
  private readonly shoreResolution: number
  private readonly shoreCell: number
  emitted = 0
  active = 0
  private dropsSettled = false
  private sheetsSettled = false

  private readonly bed: LakeBed
  private readonly physics: PhysicsWorld
  constructor(scene: Scene, bed: LakeBed, seed: number, mobile: boolean, physics: PhysicsWorld) {
    this.bed = bed
    this.physics = physics
    this.state = (seed ^ 0x591a7e) >>> 0
    this.impacts = new SplashImpacts(scene, mobile)
    // The waterfall foot jets share the pool; the headroom keeps the ring
    // cursor from evicting live shore drops.
    this.capacity = mobile ? 192 : 448
    const { ColliderDesc, RigidBodyDesc } = physics.rapier
    physics.world.timestep = SPLASH_STEP
    this.drops = Array.from({ length: this.capacity }, () => {
      const body = physics.world.createRigidBody(
        RigidBodyDesc.dynamic().setTranslation(0, PARKED_Y, 0).setCanSleep(false).setEnabled(false),
      )
      physics.world.createCollider(
        ColliderDesc.ball(DROP_RADIUS)
          .setDensity(1000)
          .setRestitution(0.45)
          .setFriction(0.4)
          .setCollisionGroups(DROPLET_GROUPS),
        body,
      )
      return {
        body,
        born: 0,
        size: 0,
        drag: 0,
        windX: 0,
        windZ: 0,
        slowSteps: 0,
        ring: new Float64Array(RING_SAMPLES * 4),
        ringCount: 0,
        active: false,
      }
    })
    this.shoreResolution = Math.sqrt(bed.shore.length)
    this.shoreCell = LAKE_BOUNDS.size / this.shoreResolution
    const candidates: Array<Contact & { order: number }> = []
    const n = this.shoreResolution,
      cell = this.shoreCell
    for (let row = 1; row < n - 1; row += 2)
      for (let col = 1; col < n - 1; col += 2) {
        const index = row * n + col,
          distance = required(bed.shore[index])
        if (distance <= 0 || distance > cell * 1.7) continue
        const x = LAKE_BOUNDS.minX + (col + 0.5) * cell
        const z = LAKE_BOUNDS.minZ + (row + 0.5) * cell
        if (Math.abs(x) > (mobile ? 25 : 55) || z < -80 || z > 12) continue
        let nx = required(bed.shore[index + 1]) - required(bed.shore[index - 1])
        let nz = required(bed.shore[index + n]) - required(bed.shore[index - n])
        const length = Math.hypot(nx, nz)
        if (length < 0.0001) continue
        nx /= length
        nz /= length
        candidates.push({
          x: x - nx * distance + nx * 0.04,
          z: z - nz * distance + nz * 0.04,
          nx,
          nz,
          armed: true,
          next: this.random() * 3,
          // Keep most detail on the shores that can be read from the camera.
          order:
            this.random() +
            Math.hypot(x * 0.8, z - 12) / 90 +
            (this.visibleFromCamera(x - nx * distance + nx * 0.04, z - nz * distance + nz * 0.04)
              ? 0
              : 4),
        })
      }
    candidates.sort((a, b) => a.order - b.order)
    for (const candidate of candidates) {
      if (this.contacts.length >= (mobile ? 64 : 160)) break
      if (
        this.contacts.every(
          (contact) => Math.hypot(contact.x - candidate.x, contact.z - candidate.z) > 1.3,
        )
      )
        this.contacts.push(candidate)
    }
    // Smooth ellipsoids rather than faceted voxel debris. Their long axis follows
    // velocity and contracts near the apex, where surface tension rounds drops.
    const geometry = new SphereGeometry(1, 10, 7)
    geometry.setAttribute(
      'aSplashOpacity',
      new InstancedBufferAttribute(new Float32Array(this.capacity), 1).setUsage(DynamicDrawUsage),
    )
    const material = new MeshStandardNodeMaterial({
      color: 0xd3e7e6,
      roughness: 0.12,
      envMapIntensity: 1.35,
      metalness: 0,
      transparent: true,
      depthWrite: false,
    })
    material.opacityNode = attribute('aSplashOpacity', 'float')
    this.mesh = new InstancedMesh(geometry, material, this.capacity)
    this.mesh.name = 'shore-impact-splashes'
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
    this.mesh.visible = false
    this.mesh.renderOrder = 2
    scene.add(this.mesh)
    const sheetGeometry = new PlaneGeometry(1, 1, 36, 12)
    sheetGeometry.setAttribute(
      'aSheet',
      new InstancedBufferAttribute(new Float32Array(24 * 3), 3).setUsage(DynamicDrawUsage),
    )
    sheetGeometry.setAttribute(
      'aSheetShape',
      new InstancedBufferAttribute(new Float32Array(24 * 4), 4).setUsage(DynamicDrawUsage),
    )
    sheetGeometry.setAttribute(
      'aSheetTiming',
      new InstancedBufferAttribute(new Float32Array(24 * 3), 3).setUsage(DynamicDrawUsage),
    )
    const sheetMaterial = new SheetMaterial({
      color: 0xbcd5d8,
      roughness: 0.12,
      envMapIntensity: 1.25,
      metalness: 0,
      transparent: true,
      side: DoubleSide,
      forceSinglePass: true,
      depthWrite: false,
    })
    const sheet = attribute('aSheet', 'vec3'),
      shape = attribute('aSheetShape', 'vec4'),
      timing = attribute('aSheetTiming', 'vec3'),
      p = uv()
    const angle = p.x.sub(0.5).mul(shape.x).add(shape.w)
    const phase = clamp(sheet.x.div(timing.x), 0, 1)
    const lobes = floor(fract(sheet.z.mul(0.73)).mul(5)).add(3)
    const scallop = sin(
      p.x
        .mul(lobes)
        .mul(Math.PI * 2)
        .add(sheet.z),
    )
      .mul(0.1)
      .add(sin(p.x.mul(17).add(sheet.z.mul(2.3))).mul(0.04))
      .add(1)
    const rise = float(1)
      .sub(exp(phase.mul(-3.5)))
      .mul(sheet.y.mul(0.22).add(0.06))
      .mul(shape.y)
    const curl = p.y.pow(3).mul(phase).mul(sheet.y.mul(0.16).add(0.07))
    sheetMaterial.localPosition = vec3(
      p.x.sub(0.5).mul(timing.z).add(sin(angle).mul(curl).mul(shape.z)),
      p.y.mul(rise).mul(scallop),
      p.y.mul(phase).mul(0.035).add(cos(angle).mul(curl)).mul(shape.z),
    )
    const edge = smoothstep(0, 0.09, p.x)
      .mul(smoothstep(0, 0.09, float(1).sub(p.x)))
      .mul(smoothstep(0, 0.15, p.y))
      .mul(smoothstep(0, 0.04, float(1).sub(p.y)))
    const holes = noise(p.mul(vec2(19, 8)).add(sheet.z)),
      threads = noise(p.mul(vec2(37, 4)).add(sheet.z.mul(2)))
    const breakup = smoothstep(timing.y, 0.9, phase)
    const film = smoothstep(
      breakup.mul(0.85),
      breakup.mul(0.85).add(0.12),
      holes.mul(0.7).add(threads.mul(0.3)),
    )
    sheetMaterial.opacityNode = edge
      .mul(film)
      .mul(smoothstep(0, 0.03, sheet.x))
      .mul(float(1).sub(smoothstep(0.55, 1, phase)))
      .mul(0.32)
    sheetMaterial.alphaTest = 0.005
    sheetMaterial.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView))).mul(
      faceDirection,
    )
    this.sheets = new InstancedMesh(sheetGeometry, sheetMaterial, 24)
    this.sheets.name = 'shore-impact-sheets'
    this.sheets.instanceMatrix.setUsage(DynamicDrawUsage)
    this.sheets.frustumCulled = false
    this.sheets.receiveShadow = true
    this.sheets.visible = false
    scene.add(this.sheets)
  }

  private visibleFromCamera(x: number, z: number) {
    const distance = Math.hypot(x, z - 16)
    for (let step = 0.5; step < distance; step += 0.45) {
      const t = step / distance
      const index = lakeIndex(this.bed, x * (1 - t), z + (16 - z) * t)
      if (index >= 0 && required(this.bed.obstacle[index]) > WATER_LEVEL + 0.04 + t * 2.3)
        return false
    }
    return true
  }

  private random() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0
    return this.state / 0x1_0000_0000
  }

  private shoreAt(x: number, z: number) {
    return sampleShore(this.bed, x, z)
  }

  private shoreOrigin(contact: Contact, offset: number) {
    // Slide on the actual wet boundary. Reject corners whose outward normal
    // no longer matches the struck face instead of emitting through solid rock.
    const x = contact.x - contact.nz * offset,
      z = contact.z + contact.nx * offset
    const distance = this.shoreAt(x, z)
    const px = x + contact.nx * (0.055 - distance),
      pz = z + contact.nz * (0.055 - distance)
    const wet = this.shoreAt(px, pz)
    if (
      wet < 0.005 ||
      wet > 0.16 ||
      this.shoreAt(px - contact.nx * 0.15, pz - contact.nz * 0.15) > -0.015
    )
      return null
    return { x: px, z: pz }
  }

  private sampleDrop(profile: SplashProfile, strength: number, index: number) {
    const jet = required(
      profile.jets[
        index < profile.jets.length ? index : Math.floor(this.random() * profile.jets.length)
      ],
    )
    const fine = this.random() < 0.32
    return {
      jet,
      speed: (0.25 + strength * 0.65) * profile.reach * jet.speed * (0.6 + this.random() * 0.8),
      lift: (0.55 + strength * 1.65) * profile.lift * jet.lift * (0.55 + this.random() * 0.9),
      delay: jet.delay + (index / profile.count) * profile.emission,
      size: fine
        ? 0.004 + this.random() * 0.007
        : 0.01 + this.random() ** 2 * (0.013 + strength * 0.019),
      drag: fine ? 4 + this.random() * 5 : 0.3 + this.random() * 0.9,
    }
  }

  private release(spawn: PendingDrop) {
    const drop = required(this.drops[this.cursor])
    this.cursor = (this.cursor + 1) % this.capacity
    if (drop.active) this.kill(drop)
    drop.body.setEnabled(true)
    drop.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true)
    drop.body.setLinvel({ x: spawn.vx, y: spawn.vy, z: spawn.vz }, true)
    drop.born = this.stepTime
    drop.size = spawn.size
    drop.drag = spawn.drag
    drop.windX = spawn.windX
    drop.windZ = spawn.windZ
    drop.slowSteps = 0
    drop.ring.set([spawn.x, spawn.y, spawn.z, this.stepTime], 0)
    drop.ringCount = 1
    drop.active = true
  }

  private releaseDue() {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const spawn = required(this.pending[i])
      if (spawn.release > this.stepTime) continue
      this.pending.splice(i, 1)
      this.release(spawn)
    }
  }

  private applyWind() {
    for (const drop of this.drops) {
      if (!drop.active) continue
      const velocity = drop.body.linvel(this.velocityTarget)
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z)
      drop.slowSteps = speed < 0.12 ? drop.slowSteps + 1 : 0
      const pull = DROP_MASS * drop.drag
      this.forceTarget.x = pull * (drop.windX - velocity.x)
      this.forceTarget.y = pull * -velocity.y
      this.forceTarget.z = pull * (drop.windZ - velocity.z)
      drop.body.resetForces(false)
      drop.body.addForce(this.forceTarget, false)
    }
  }

  private kill(drop: Drop) {
    drop.active = false
    drop.body.setEnabled(false)
  }

  private recordStep(drop: Drop) {
    const position = drop.body.translation(this.positionTarget)
    if (drop.ringCount >= RING_SAMPLES) drop.ring.copyWithin(0, 4)
    else drop.ringCount++
    drop.ring.set([position.x, position.y, position.z, this.stepTime], (drop.ringCount - 1) * 4)
  }

  private ringSample(drop: Drop, slot: number) {
    const base = slot * 4
    return {
      x: required(drop.ring[base]),
      y: required(drop.ring[base + 1]),
      z: required(drop.ring[base + 2]),
      t: required(drop.ring[base + 3]),
    }
  }

  private ringGap(drop: Drop, slot: number, wind: WindState) {
    const sample = this.ringSample(drop, slot)
    return sample.y - WATER_LEVEL - sampleWindField(sample.x, sample.z, sample.t, wind, 0.08)[0]
  }

  /** Frame detection at wall time, refined on the step-grid bracket for frame-rate independence. */
  private land(
    drop: Drop,
    x: number,
    y: number,
    z: number,
    speed: number,
    time: number,
    wind: WindState,
  ) {
    let from = drop.ringCount - 1
    while (from >= 0 && this.ringGap(drop, from, wind) <= 0) from--
    // A grid-to-grid crossing refines identically at every frame rate. Past the
    // last step the body did not move, so the wave-rise fallback shares its endpoints.
    const start = this.ringSample(drop, Math.max(0, from))
    const end =
      from < 0 || from + 1 >= drop.ringCount
        ? { x, y, z, t: time }
        : this.ringSample(drop, from + 1)
    let low = 0,
      high = 1,
      hitX = end.x,
      hitZ = end.z
    for (let iteration = 0; iteration < 7; iteration++) {
      const mid = (low + high) * 0.5
      const sampleX = start.x + (end.x - start.x) * mid
      const sampleY = start.y + (end.y - start.y) * mid
      const sampleZ = start.z + (end.z - start.z) * mid
      const gap =
        sampleY -
        WATER_LEVEL -
        sampleWindField(sampleX, sampleZ, start.t + (end.t - start.t) * mid, wind, 0.08)[0]
      if (gap > 0) low = mid
      else {
        high = mid
        hitX = sampleX
        hitZ = sampleZ
      }
    }
    if (this.shoreAt(hitX, hitZ) > 0) {
      const energy = Math.min(1, Math.max(0.08, ((drop.size / 0.045) ** 2 * speed) / 3))
      this.impacts.add(hitX, hitZ, time, energy)
      this.onReturn?.(hitX, hitZ, 0.15 + energy * 0.2, -(0.012 + energy * 0.05))
    }
    this.kill(drop)
  }

  private updateDrop(
    drop: Drop,
    index: number,
    time: number,
    wind: WindState,
    opacity: BufferAttribute | InterleavedBufferAttribute,
  ) {
    if (drop.active) {
      const position = drop.body.translation(this.positionTarget)
      const velocity = drop.body.linvel(this.velocityTarget)
      const surface = WATER_LEVEL + sampleWindField(position.x, position.z, time, wind, 0.08)[0]
      if (velocity.y < 0 && position.y <= surface)
        this.land(drop, position.x, position.y, position.z, -velocity.y, time, wind)
      else {
        const age = this.stepTime - drop.born
        const settled =
          !Number.isFinite(position.x + position.y + position.z) ||
          age > DROP_LIFE ||
          position.y < WATER_LEVEL - 1.5 ||
          drop.slowSteps > SETTLE_STEPS
        if (settled) this.kill(drop)
        else {
          this.active++
          const speed = Math.hypot(velocity.x, velocity.y, velocity.z)
          this.dropPosition.set(position.x, position.y, position.z)
          this.velocity.set(velocity.x, velocity.y, velocity.z)
          this.transform.position.copy(this.dropPosition)
          this.transform.quaternion.setFromUnitVectors(this.up, this.velocity.normalize())
          this.transform.scale.set(drop.size * 0.7, drop.size * (1 + speed * 0.22), drop.size * 0.7)
          opacity.setX(
            index,
            Math.min(1, age / 0.035) * Math.min(1, (DROP_LIFE - age) / 0.12) * 0.85,
          )
          return
        }
      }
    }
    this.transform.scale.setScalar(0)
    opacity.setX(index, 0)
  }

  /** Queues an externally sourced droplet; its landing rings like a shore drop. */
  emit(jet: SplashJet) {
    this.pending.push(jet)
  }

  /** A grouped curtain landing drives the lake disturbance and a few recycled droplets. */
  waterfallImpact(impact: WaterfallImpact, wind: WindState) {
    if (this.shoreAt(impact.x, impact.z) <= 0) return
    const energy = Math.max(0.08, impact.energy)
    this.impacts.add(impact.x, impact.z, impact.time, energy)
    this.onReturn?.(impact.x, impact.z, 0.16 + energy * 0.2, -(0.012 + energy * 0.045))
    const angle = this.random() * Math.PI * 2
    const speed = 0.35 + energy * (0.45 + this.random() * 0.65)
    this.emit({
      x: impact.x + Math.cos(angle) * 0.035,
      y: WATER_LEVEL + 0.025,
      z: impact.z + Math.sin(angle) * 0.035,
      vx: Math.cos(angle) * speed + wind.direction[0] * wind.speed * 0.025,
      vy: 0.8 + energy * (0.8 + this.random() * 0.8),
      vz: Math.sin(angle) * speed + wind.direction[1] * wind.speed * 0.025,
      size: 0.015 + energy * 0.015,
      drag: 0.4 + this.random() * 0.5,
      windX: wind.direction[0] * wind.speed * 0.1,
      windZ: wind.direction[1] * wind.speed * 0.1,
      release: impact.time,
    })
  }

  private readonly preStepHooks = new Set<(stepTime: number) => void>()

  /** Register per-step forces on the shared world; this loop remains its only stepper. */
  addPreStep(hook: (stepTime: number) => void) {
    this.preStepHooks.add(hook)
    return () => {
      this.preStepHooks.delete(hook)
    }
  }

  /** Radial open-water burst for pointer impacts; wall sheets stay with the shore branch. */
  spawnBurst(x: number, z: number, energy: number, time: number, wind: WindState) {
    const strength = Math.max(0, Math.min(1, energy))
    if (!(strength > 0)) return
    const index = lakeIndex(this.bed, x, z)
    if (index < 0 || !this.bed.water[index]) return
    const profile = createSplashProfile(() => this.random(), strength)
    this.emitted++
    this.impacts.add(x, z, time, strength)
    const surface = WATER_LEVEL + sampleWindField(x, z, time, wind, 0.08)[0]
    const { count } = profile
    for (let i = 0; i < count; i++) {
      const drop = this.sampleDrop(profile, strength, i)
      const angle = (i / count) * Math.PI * 2 + (this.random() - 0.5) * 0.7
      const spread = 0.02 + this.random() * 0.06
      this.pending.push({
        x: x + Math.cos(angle) * spread,
        y: surface + 0.015 + this.random() * (0.02 + strength * 0.06),
        z: z + Math.sin(angle) * spread,
        vx: Math.cos(angle) * drop.speed + wind.direction[0] * wind.speed * 0.025,
        vz: Math.sin(angle) * drop.speed + wind.direction[1] * wind.speed * 0.025,
        vy: drop.lift,
        size: drop.size,
        drag: drop.drag,
        windX: wind.direction[0] * wind.speed * 0.1,
        windZ: wind.direction[1] * wind.speed * 0.1,
        release: time + drop.delay,
      })
    }
  }

  update(time: number, wind: WindState, reducedMotion = false, intro = 1) {
    if (reducedMotion) {
      for (const drop of this.drops) if (drop.active) this.kill(drop)
      this.pending.length = 0
      this.accumulator = 0
      this.lastTime = time
      this.mesh.visible = false
      this.sheets.visible = false
      this.impacts.update(time, true)
      return
    }
    if (time >= this.nextCheck && intro > 0.8) {
      this.nextCheck = time + 0.1
      let bursts = 0
      for (const contact of this.contacts) {
        const [height, , , velocity] = sampleWindField(contact.x, contact.z, time, wind, 0.08)
        if (velocity < -0.008) contact.armed = true
        const facing = Math.max(0, -contact.nx * wind.direction[0] - contact.nz * wind.direction[1])
        const force = Math.max(0, Math.min(1, (wind.speed - 1.7) / 5)) * facing
        if (
          !contact.armed ||
          time < contact.next ||
          force < 0.08 ||
          velocity < 0.018 ||
          height < -0.006
        )
          continue
        contact.armed = false
        contact.next = time + 1.8 + this.random() * 4.5
        // Qualifying waves can still wash quietly; exposed, stronger impacts
        // are more likely to break. There is no periodic splash emitter.
        if (bursts >= 3 || this.random() > 0.18 + force * 0.67) continue
        const energy = Math.min(1, force * 0.7 + velocity * 4)
        const profile = createSplashProfile(() => this.random(), energy)
        let origin = this.shoreOrigin(contact, (this.random() - 0.5) * 1.6)
        for (let attempt = 0; !origin && attempt < 3; attempt++)
          origin = this.shoreOrigin(contact, (this.random() - 0.5) * 1.2)
        if (!origin) continue
        const patch = { ...contact, x: origin.x, z: origin.z }
        // Fit the sheet to the same contiguous face used for its droplets.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (
            this.shoreOrigin(patch, -profile.width * 0.5) &&
            this.shoreOrigin(patch, profile.width * 0.5)
          )
            break
          profile.width *= 0.5
        }
        // A narrow invalid patch would recreate a fixed nozzle at block corners.
        if (profile.width < 0.18) continue
        const { count } = profile
        this.emitted++
        bursts++
        this.sheetsState[this.sheetCursor] = {
          x: origin.x,
          y: WATER_LEVEL + sampleWindField(origin.x, origin.z, time, wind, 0.08)[0],
          z: origin.z,
          heading: Math.atan2(contact.nx, contact.nz),
          born: time,
          energy,
          profile,
        }
        this.sheetCursor = (this.sheetCursor + 1) % this.sheetsState.length
        for (let i = 0; i < count; i++) {
          const drop = this.sampleDrop(profile, energy, i)
          const angle = drop.jet.angle + (this.random() - 0.5) * 0.1
          const source =
            this.shoreOrigin(patch, ((i + this.random()) / count - 0.5) * profile.width) ?? origin
          const side = Math.sin(angle) * drop.speed
          const outward = Math.cos(angle) * drop.speed
          this.pending.push({
            x: source.x + contact.nx * (0.015 + this.random() * 0.07),
            y:
              WATER_LEVEL +
              Math.max(
                0.015,
                sampleWindField(source.x, source.z, time + drop.delay, wind, 0.08)[0] + 0.015,
              ) +
              this.random() * (0.025 + energy * 0.09),
            z: source.z + contact.nz * (0.015 + this.random() * 0.07),
            vx: contact.nx * outward - contact.nz * side + wind.direction[0] * wind.speed * 0.025,
            vz: contact.nz * outward + contact.nx * side + wind.direction[1] * wind.speed * 0.025,
            vy: drop.lift,
            size: drop.size,
            drag: drop.drag,
            windX: wind.direction[0] * wind.speed * 0.1,
            windZ: wind.direction[1] * wind.speed * 0.1,
            release: time + drop.delay,
          })
        }
      }
    }
    if (this.lastTime === null) this.stepTime = time
    const frameDelta = this.lastTime === null ? 0 : Math.max(0, Math.min(0.1, time - this.lastTime))
    this.lastTime = time
    this.accumulator = Math.min(this.accumulator + frameDelta, SPLASH_STEP * MAX_SPLASH_STEPS)
    const steps = Math.min(MAX_SPLASH_STEPS, Math.floor((this.accumulator + 1e-9) / SPLASH_STEP))
    this.accumulator = Math.max(0, this.accumulator - steps * SPLASH_STEP)
    for (let step = 0; step < steps; step++) {
      this.releaseDue()
      for (const hook of this.preStepHooks) hook(this.stepTime)
      this.applyWind()
      this.physics.world.step()
      this.stepTime += SPLASH_STEP
      for (const drop of this.drops) {
        if (drop.active) this.recordStep(drop)
      }
    }
    this.active = 0
    // Landing detection runs inside the presentation loop, so an idle frame can
    // only skip it once zeroed buffers were already uploaded and the mesh hidden.
    const dropsLive = this.drops.some((drop) => drop.active)
    if (dropsLive || !this.dropsSettled) {
      const opacity = this.mesh.geometry.getAttribute('aSplashOpacity')
      this.transform.quaternion.identity()
      for (let i = 0; i < this.capacity; i++) {
        this.updateDrop(required(this.drops[i]), i, time, wind, opacity)
        this.transform.updateMatrix()
        this.mesh.setMatrixAt(i, this.transform.matrix)
      }
      this.mesh.instanceMatrix.needsUpdate = true
      opacity.needsUpdate = true
      this.dropsSettled = this.active === 0
    }
    this.mesh.visible = this.active > 0
    let activeSheets = 0
    const sheetsLive = this.sheetsState.some((sheet) => sheet !== null)
    if (sheetsLive || !this.sheetsSettled) {
      const sheetData = this.sheets.geometry.getAttribute('aSheet')
      const shapeData = this.sheets.geometry.getAttribute('aSheetShape')
      const timingData = this.sheets.geometry.getAttribute('aSheetTiming')
      for (let i = 0; i < this.sheetsState.length; i++) {
        const sheet = this.sheetsState[i]
        const age = sheet ? time - sheet.born : 1
        if (!sheet || age < 0 || age > sheet.profile.lifetime) {
          this.sheetsState[i] = null
          this.transform.scale.setScalar(0)
          sheetData.setXYZ(i, 0, 0, 0)
          timingData.setXYZ(i, 1, 0.3, 0)
        } else {
          activeSheets++
          this.transform.position.set(sheet.x, sheet.y, sheet.z)
          this.transform.rotation.set(0, sheet.heading, 0)
          this.transform.scale.setScalar(1)
          sheetData.setXYZ(i, age, sheet.energy, sheet.profile.seed)
          shapeData.setXYZW(
            i,
            sheet.profile.fan,
            sheet.profile.lift,
            sheet.profile.reach,
            sheet.profile.lean,
          )
          timingData.setXYZ(i, sheet.profile.lifetime, sheet.profile.tear, sheet.profile.width)
        }
        this.transform.updateMatrix()
        this.sheets.setMatrixAt(i, this.transform.matrix)
      }
      this.sheets.instanceMatrix.needsUpdate = true
      sheetData.needsUpdate = shapeData.needsUpdate = timingData.needsUpdate = true
      this.sheetsSettled = activeSheets === 0
    }
    this.sheets.visible = activeSheets > 0
    this.impacts.update(time)
  }

  /** Compile inactive batches without advancing their seeded simulation or displaying them. */
  compileAsync(compile: () => Promise<void>): Promise<void> {
    return this.withActiveBatches(compile)
  }

  warmup(render: () => void) {
    this.withActiveBatches(render)
  }

  private withActiveBatches<T>(prepare: () => T): T {
    const states = [this.mesh, this.sheets, this.impacts.mesh, this.impacts.slopes].map((mesh) => ({
      mesh,
      visible: mesh.visible,
      count: mesh.count,
    }))
    try {
      for (const { mesh } of states) {
        mesh.visible = true
        mesh.count = Math.max(1, mesh.count)
      }
      // Three collects the render list before its first await. Restore before the loader's frame.
      return prepare()
    } finally {
      for (const { mesh, visible, count } of states) {
        mesh.visible = visible
        mesh.count = count
      }
    }
  }

  dispose() {
    this.preStepHooks.clear()
    for (const drop of this.drops) this.physics.world.removeRigidBody(drop.body)
    this.drops.length = 0
    this.pending.length = 0
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
    this.sheets.removeFromParent()
    this.sheets.geometry.dispose()
    this.sheets.material.dispose()
    this.sheets.dispose()
    this.impacts.dispose()
  }
}
