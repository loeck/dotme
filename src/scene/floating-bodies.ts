import type { RigidBody } from '@dimforge/rapier3d-compat'
import { attribute, float, fract, fwidth, mix, positionGeometry, smoothstep, vec3 } from 'three/tsl'
import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  InstancedBufferAttribute,
  MeshStandardNodeMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three/webgpu'
import type { Ray, Scene, Vector4 } from 'three/webgpu'

import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex, sampleShore } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { FISH_LAYER } from './lake-fish'
import type { LakeSplashes } from './lake-splashes'
import type { PhysicsWorld } from './physics-world'
import { surfaceGradientNormal } from './surface-detail'
import type { WaterContact } from './water-contact'
import { contactNoise } from './water-noise'
import { sampleWaterContact } from './water-surface'
import type { WindState } from './wind'

/**
 * Floaters strike terrain only: neither droplets, fish, nor each other. The buoy has its own
 * membership so that, while held, it shoulders the leaves aside (and they it).
 */
const FLOATER_GROUPS = (0x0002 << 16) | 0x0011
const BUOY_GROUPS = (0x0010 << 16) | 0x0001
const HELD_BUOY_GROUPS = (0x0010 << 16) | 0x0003
const GRAVITY = 9.81

/**
 * The held buoy follows the pointer on a damped spring rather than being placed, so it lags,
 * collides and still feels the water: drag toward the water's own motion and the buoyancy of
 * its wetted share (its weight is carried by the hand).
 */
/** Height above the surface, metres, the held buoy must clear before it counts as out. */
const HELD_CLEARANCE = 0.08

export const GRAB = {
  /** Spring and damping per unit mass: slightly under critical, so it overshoots a touch. */
  stiffness: 120,
  damping: 18,
  /** Largest spring acceleration, m/s². */
  limit: 100,
  /** Water drag per second at full immersion. */
  waterDrag: 7,
  /** How far under the resting level the hand may push it, in radii. */
  depth: 1.3,
  /**
   * A continuous wake while it moves through the water: every physics step lays splats along
   * the segment it travelled, one per `wakeSpacing` metres at most (and at most `wakeSamples`
   * a step), each `wakeStrength` × speed × immersion of the GPU field's impulse velocity per
   * `wakeSpacing` travelled (so a metre of path deposits the same at any step rate), capped at
   * `wakeDepth`. As broad as a pointer stroke's splat: narrower, repeated splats steepen the
   * field until its shading breaks. The solver turns the trail into a spreading V.
   */
  wakeSpacing: 0.08,
  wakeSamples: 4,
  wakeRadius: 0.45,
  wakeStrength: 0.018,
  wakeFloor: 0.005,
  wakeDepth: 0.05,
} as const

/**
 * Acceleration along one axis of a held body `offset` metres short of its target, moving at
 * `velocity` through water moving at `water`, `immersion` 0–1 wet; `vertical` adds buoyancy.
 */
export function grabAcceleration(
  offset: number,
  velocity: number,
  water: number,
  immersion: number,
  vertical: boolean,
) {
  const spring = Math.max(
    -GRAB.limit,
    Math.min(GRAB.limit, offset * GRAB.stiffness - velocity * GRAB.damping),
  )
  const wet = Math.max(0, Math.min(1, immersion))
  return spring + (water - velocity) * GRAB.waterDrag * wet + (vertical ? GRAVITY * wet : 0)
}
const SPLASH_SPEED = 1
const LEAF_COLORS = [0x4a7c3a, 0x5d8f43, 0x3d6e33]
const BUOY_POINTS = [
  [0, 0],
  [0.7, 0],
  [0, 0.7],
  [-0.7, 0],
  [0, -0.7],
] as const
const LEAF_POINTS = [
  [0.7, 0],
  [-0.35, 0.606],
  [-0.35, -0.606],
] as const

type Floater = {
  body: RigidBody
  radius: number
  mass: number
  windage: number
  flatten: number
  home: { x: number; z: number }
  wakeAt: number
  /** Where the held buoy's wake segment starts: its position at the last step, NaN if dry. */
  trailX: number
  trailZ: number
  dry: boolean
  born: number
  fadeAt: number
}

type FloaterSpec = {
  radius: number
  density: number
  windage: number
  flatten: number
  color: number
}

/** Buoyant props riding the same analytic wind field as splash ballistics. */
export class FloatingBodies {
  readonly mesh: InstancedMesh<SphereGeometry, MeshStandardNodeMaterial>
  private readonly floaters: Floater[] = []
  private readonly transform = new Object3D()
  private readonly point = new Vector3()
  private readonly bodyRotation = new Quaternion()
  private wind: WindState | null = null
  private readonly releaseHook: () => void
  onWake?: (x: number, z: number, radius: number, velocity: number) => void
  private time = 0
  private state: number
  private readonly physics: PhysicsWorld
  private readonly splashes: LakeSplashes
  private readonly bed: LakeBed
  private contact?: WaterContact
  private held: Floater | null = null
  private readonly grabTarget = new Vector3()
  private readonly leafSources: Vector3[] = []
  private nextLeaf = 6
  private readonly leafPockets: Array<{ x: number; z: number }> = []

  constructor(
    scene: Scene,
    bed: LakeBed,
    seed: number,
    mobile: boolean,
    physics: PhysicsWorld,
    splashes: LakeSplashes,
  ) {
    this.physics = physics
    this.splashes = splashes
    this.bed = bed
    this.state = (seed ^ 0x3f10a7) >>> 0
    this.findLeafPockets()
    const specs: FloaterSpec[] = [
      { radius: 0.075, density: 500, windage: 0.25, flatten: 1, color: 0x91625a },
    ]
    // Seven leaves plus the buoy fit the lake material's eight contact slots.
    const leaves = mobile ? 4 : 7
    for (let i = 0; i < leaves; i++)
      specs.push({
        radius: 0.035 + this.random() * 0.015,
        density: 350,
        windage: 1,
        flatten: 0.12,
        color: LEAF_COLORS[i % LEAF_COLORS.length] ?? 0x4a7c3a,
      })
    const { ColliderDesc, RigidBodyDesc } = physics.rapier
    const placed = specs
      .map((spec, i) => ({
        spec,
        home:
          i === 0
            ? this.findWater(bed, 3, 5, 0.5)
            : this.findWater(bed, -9 + this.random() * 18, -14 + this.random() * 23, 0.3),
      }))
      .filter(
        (entry): entry is { spec: FloaterSpec; home: { x: number; z: number } } =>
          entry.home !== null,
      )
    for (const { spec, home } of placed) {
      const body = physics.world.createRigidBody(
        RigidBodyDesc.dynamic()
          .setTranslation(home.x, WATER_LEVEL, home.z)
          .setLinearDamping(0.3)
          .setAngularDamping(2)
          .setCanSleep(false),
      )
      physics.world.createCollider(
        ColliderDesc.ball(spec.radius)
          .setDensity(spec.density)
          .setRestitution(0.25)
          .setFriction(0.6)
          .setCollisionGroups(spec.flatten < 1 ? FLOATER_GROUPS : BUOY_GROUPS),
        body,
      )
      this.floaters.push({
        body,
        radius: spec.radius,
        mass: spec.density * (4 / 3) * Math.PI * spec.radius ** 3,
        windage: spec.windage,
        flatten: spec.flatten,
        home,
        wakeAt: -Infinity,
        trailX: Number.NaN,
        trailZ: Number.NaN,
        dry: false,
        born: -Infinity,
        fadeAt: Infinity,
      })
    }
    const geometry = new SphereGeometry(1, 12, 8)
    const material = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 })
    geometry.setAttribute(
      'aLeaf',
      new InstancedBufferAttribute(
        Float32Array.from(placed, ({ spec }) => (spec.flatten < 1 ? 1 : 0)),
        1,
      ),
    )
    const leaf = attribute('aLeaf', 'float')
    const q = positionGeometry
    const pixel = fwidth(q).length()
    const resolved = smoothstep(0.12, 0.025, pixel)
    const grain = contactNoise(q.xz.mul(28)).sub(0.5).mul(resolved)
    const midrib = smoothstep(pixel.add(0.055), pixel.mul(0.3).add(0.015), q.z.abs())
    const veins = fract(q.x.mul(5).add(q.z.abs().mul(7)))
    const sideVeins = smoothstep(0.13, 0.03, veins).mul(smoothstep(0.2, 0.02, pixel))
    const leafTone = q.x.mul(0.08).add(0.94).add(midrib.mul(0.2)).add(sideVeins.mul(0.1))
    material.colorNode = vec3(mix(grain.mul(0.12).add(1), leafTone, leaf))
    material.roughnessNode = mix(grain.mul(0.12).add(0.43), float(0.88), leaf)
    const relief = mix(grain.mul(0.00025), midrib.mul(0.0003).add(sideVeins.mul(0.00012)), leaf)
    material.normalNode = surfaceGradientNormal(relief, float(1))
    this.mesh = new InstancedMesh(geometry, material, this.floaters.length)
    this.mesh.name = 'floating-bodies'
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
    // The fish capture is what the lake refracts, so submerged halves stay visible.
    this.mesh.layers.enable(FISH_LAYER)
    placed.forEach(({ spec }, i) => this.mesh.setColorAt(i, new Color(spec.color)))
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
    this.floaters.forEach((floater, i) => this.place(i, floater))
    this.mesh.instanceMatrix.needsUpdate = true
    scene.add(this.mesh)
    this.releaseHook = splashes.addPreStep((stepTime) => this.applyStepForces(stepTime))
  }

  private random() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0
    return this.state / 0x1_0000_0000
  }

  private findWater(bed: LakeBed, x: number, z: number, margin: number) {
    const accept = (px: number, pz: number) => {
      const index = lakeIndex(bed, px, pz)
      if (index < 0 || !bed.water[index] || sampleShore(bed, px, pz) < margin) return null
      return { x: px, z: pz }
    }
    const direct = accept(x, z)
    if (direct) return direct
    for (let ring = 1; ring <= 20; ring++)
      for (let spoke = 0; spoke < 8; spoke++) {
        const found = accept(
          x + Math.cos((spoke / 8) * Math.PI * 2) * ring,
          z + Math.sin((spoke / 8) * Math.PI * 2) * ring,
        )
        if (found) return found
      }
    return null
  }

  /** Concave banks and stone lees, limited to the visible part of the lake. */
  private findLeafPockets() {
    const candidates: Array<{ x: number; z: number; shelter: number }> = []
    for (let z = -35; z < 12; z += 0.5)
      for (let x = -22; x < 22; x += 0.5) {
        const shore = sampleShore(this.bed, x, z)
        const index = lakeIndex(this.bed, x, z)
        if (shore < 0.18 || shore > 0.65 || index < 0 || !this.bed.water[index]) continue
        let shelter = 0
        for (let spoke = 0; spoke < 8; spoke++) {
          const angle = (spoke * Math.PI) / 4
          if (sampleShore(this.bed, x + Math.cos(angle) * 1.1, z + Math.sin(angle) * 1.1) < 0.08)
            shelter++
        }
        if (shelter >= 3) candidates.push({ x, z, shelter })
      }
    candidates.sort((a, b) => b.shelter - a.shelter || b.z - a.z)
    for (const candidate of candidates) {
      if (this.leafPockets.length >= 48) break
      if (this.leafPockets.every((p) => Math.hypot(p.x - candidate.x, p.z - candidate.z) > 1.2))
        this.leafPockets.push(candidate)
    }
  }

  private leafCurrent(x: number, z: number, driftX: number, driftZ: number) {
    const shore = sampleShore(this.bed, x, z)
    if (shore > 1.8) return { x: driftX, z: driftZ, damping: 0 }
    let target: { x: number; z: number } | undefined
    let distance = 1.6
    for (const pocket of this.leafPockets) {
      const d = Math.hypot(pocket.x - x, pocket.z - z)
      if (d >= distance) continue
      // A nearby pocket across a rock is not reachable by this local current.
      let clear = true
      for (let step = 1; step <= 8; step++)
        if (
          sampleShore(this.bed, x + ((pocket.x - x) * step) / 8, z + ((pocket.z - z) * step) / 8) <
          0.09
        ) {
          clear = false
          break
        }
      if (clear) {
        target = pocket
        distance = d
      }
    }
    const shelter = target ? Math.max(0, 1 - distance / 1.6) : 0
    let vx = driftX * (1 - shelter * 0.92) + (target ? (target.x - x) * 0.055 * shelter : 0)
    let vz = driftZ * (1 - shelter * 0.92) + (target ? (target.z - z) * 0.055 * shelter : 0)
    if (shore < 0.45) {
      const dx = sampleShore(this.bed, x + 0.12, z) - sampleShore(this.bed, x - 0.12, z)
      const dz = sampleShore(this.bed, x, z + 0.12) - sampleShore(this.bed, x, z - 0.12)
      const length = Math.hypot(dx, dz)
      if (length > 0.001) {
        const nx = dx / length,
          nz = dz / length
        const inward = Math.min(0, vx * nx + vz * nz)
        // Deflect into a bank-parallel flow and hold a small water gap at the edge.
        const repel = Math.max(0, 0.18 - shore) * 0.7
        vx += nx * (repel - inward)
        vz += nz * (repel - inward)
      }
    }
    return { x: vx, z: vz, damping: shelter * 1.5 }
  }

  private surfaceAt(x: number, z: number, time: number, wind: WindState, footprint: number) {
    if (this.contact) return this.contact.sample(x, z, time, wind, footprint)
    const [height, dx, dz, speed] = sampleWaterContact(x, z, time, wind, footprint)
    return [WATER_LEVEL + height, dx, dz, speed] as const
  }

  /** A screen-sized tolerance makes the small buoy usable with mouse, pen and touch. */
  grab(ray: Ray, padding: number, maxDistance: number): Vector3 | null {
    for (const floater of this.floaters) {
      if (floater.flatten < 1) continue
      const position = this.point.copy(floater.body.translation())
      const along = position.clone().sub(ray.origin).dot(ray.direction)
      if (
        along < 0 ||
        along > maxDistance ||
        ray.distanceToPoint(position) > floater.radius + along * padding
      )
        continue
      this.held = floater
      floater.trailX = floater.trailZ = Number.NaN
      this.grabTarget.copy(position)
      floater.body.setGravityScale(0, true)
      this.setGroups(floater, HELD_BUOY_GROUPS)
      return position.clone()
    }
    return null
  }

  moveGrab(target: Vector3) {
    if (!this.held || !Number.isFinite(target.x + target.y + target.z)) return
    this.grabTarget.set(
      Math.max(-LAKE_BOUNDS.size / 2 + 6, Math.min(LAKE_BOUNDS.size / 2 - 6, target.x)),
      Math.max(WATER_LEVEL - this.held.radius * GRAB.depth, Math.min(WATER_LEVEL + 6, target.y)),
      Math.max(LAKE_BOUNDS.minZ + 6, Math.min(12, target.z)),
    )
  }

  releaseGrab(cancelled = false) {
    const floater = this.held
    if (!floater) return
    this.held = null
    floater.body.setGravityScale(1, true)
    this.setGroups(floater, BUOY_GROUPS)
    const velocity = this.point.copy(floater.body.linvel()).clampLength(0, 6)
    if (cancelled) velocity.set(0, 0, 0)
    floater.body.setLinvel(velocity, true)
  }

  private setGroups(floater: Floater, groups: number) {
    for (let i = 0; i < floater.body.numColliders(); i++)
      floater.body.collider(i).setCollisionGroups(groups)
  }

  /** Crown volumes come from the rendered trees; only overhanging water can shed here. */
  setLeafSources(crowns: Float32Array) {
    this.leafSources.length = 0
    for (let i = 0; i + 3 < crowns.length; i += 4) {
      const x = crowns[i] ?? 0,
        y = crowns[i + 1] ?? 0,
        z = crowns[i + 2] ?? 0,
        radius = crowns[i + 3] ?? 0
      if (y < WATER_LEVEL + 2 || y - radius * 0.35 > 12 || radius < 0.6 || z < -38) continue
      for (let spoke = 0; spoke < 8; spoke++) {
        const angle = (spoke * Math.PI) / 4
        const px = x + Math.cos(angle) * radius * 0.75
        const pz = z + Math.sin(angle) * radius * 0.75
        const index = lakeIndex(this.bed, px, pz)
        if (index < 0 || !this.bed.water[index] || sampleShore(this.bed, px, pz) < 0.3) continue
        this.leafSources.push(new Vector3(px, y - radius * 0.35, pz))
      }
    }
    this.leafSources.sort((a, b) => b.z - a.z)
    this.leafSources.length = Math.min(48, this.leafSources.length)
  }

  private shedLeaf(time: number) {
    if (time < this.nextLeaf || this.leafSources.length === 0) return
    this.nextLeaf = time + 8 + this.random() * 10
    const leaf =
      this.floaters.find((floater) => floater.flatten < 1 && time > floater.fadeAt) ??
      this.floaters.find((floater) => floater.flatten < 1 && floater.born === -Infinity)
    const source = this.leafSources[Math.floor(this.random() * this.leafSources.length)]
    if (!leaf || !source) return
    leaf.body.setEnabled(true)
    leaf.body.setTranslation(source, true)
    leaf.body.setLinvel({ x: 0.1, y: -0.15, z: 0.1 }, true)
    leaf.body.setAngvel({ x: 1.2, y: this.random() * 2 - 1, z: 0.6 }, true)
    leaf.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true)
    leaf.born = time
    leaf.fadeAt = time + 100 + this.random() * 30
    leaf.dry = true
  }

  private applyStepForces(stepTime: number) {
    const wind = this.wind
    if (!wind) return
    const driftX = wind.direction[0] * wind.speed * 0.03
    const driftZ = wind.direction[1] * wind.speed * 0.03
    for (const floater of this.floaters) {
      if (floater.fadeAt <= this.time) continue
      const { body } = floater
      const position = body.translation()
      const velocity = body.linvel()
      const angular = body.angvel()
      const rotation = body.rotation()
      this.bodyRotation.set(rotation.x, rotation.y, rotation.z, rotation.w)
      const points = floater.radius > 0.05 ? BUOY_POINTS : LEAF_POINTS
      const share = 1 / points.length
      body.resetForces(false)
      body.resetTorques(false)
      if (floater === this.held) {
        this.applyHeldForces(floater, stepTime, wind)
        continue
      }
      const leaf = floater.flatten < 1
      const current = leaf
        ? this.leafCurrent(position.x, position.z, driftX, driftZ)
        : { x: driftX, z: driftZ, damping: 0 }
      const onWater = lakeIndex(this.bed, position.x, position.z)
      // The picking mask is conservative; the finer shoreline owns the actual water gap.
      const afloat = onWater >= 0 && sampleShore(this.bed, position.x, position.z) > 0
      const push = (value: number) =>
        Math.max(-40, Math.min(40, Number.isFinite(value) ? value : 0)) * floater.mass
      let wet = 0
      for (const [sampleX, sampleZ] of points) {
        this.point
          .set(sampleX * floater.radius, 0, sampleZ * floater.radius)
          .applyQuaternion(this.bodyRotation)
        const { x: ox, y: oy, z: oz } = this.point
        const x = position.x + ox,
          y = position.y + oy,
          z = position.z + oz
        const [surface, dx, dz, dhdt] = this.surfaceAt(x, z, stepTime, wind, floater.radius)
        const submerged = afloat
          ? Math.max(0, Math.min(1, (surface - y + floater.radius) / (2 * floater.radius)))
          : 0
        wet += submerged * share
        if (submerged <= 0) continue
        const pointVx = velocity.x + angular.y * oz - angular.z * oy
        const pointVy = velocity.y + angular.z * ox - angular.x * oz
        const pointVz = velocity.z + angular.x * oy - angular.y * ox
        body.addForceAtPoint(
          {
            x: push(
              (-dx * GRAVITY * 0.9 +
                (current.x * floater.windage - pointVx) * (1.2 + current.damping)) *
                submerged *
                share,
            ),
            y: push((2 * GRAVITY - (pointVy - dhdt) * 4) * submerged * share),
            z: push(
              (-dz * GRAVITY * 0.9 +
                (current.z * floater.windage - pointVz) * (1.2 + current.damping)) *
                submerged *
                share,
            ),
          },
          { x, y, z },
          false,
        )
      }
      const ground =
        onWater >= 0
          ? Math.max(WATER_LEVEL, this.bed.obstacle[onWater] ?? WATER_LEVEL)
          : WATER_LEVEL
      if (wet === 0 && leaf && position.y > ground + floater.radius * 2) {
        const phase = floater.home.x * 7 + floater.home.z * 3
        body.setAngvel(
          {
            x: Math.cos(stepTime * 2.3 + phase) * 0.8,
            y: 1.1,
            z: Math.sin(stepTime * 1.7 + phase) * 0.5,
          },
          false,
        )
        body.addForce(
          {
            x: push((driftX * 3 - velocity.x) * 2 + Math.sin(stepTime * 2.3 + phase) * 1.1),
            y: push(-velocity.y * 7),
            z: push((driftZ * 3 - velocity.z) * 2 + Math.cos(stepTime * 1.7 + phase) * 0.8),
          },
          false,
        )
      }
      if (wet > 0 && floater.dry && velocity.y < -0.35) {
        const energy = Math.min(0.9, -velocity.y * (floater.flatten < 1 ? 0.035 : 0.18))
        this.onWake?.(position.x, position.z, 0.15 + floater.radius * 2, -energy * 0.08)
        if (floater.flatten === 1)
          this.splashes.spawnBurst(position.x, position.z, energy, stepTime, wind)
      }
      floater.dry = wet === 0
      const speed = Math.hypot(velocity.x, velocity.z)
      if (wet > 0.3 && speed > 0.15 && stepTime - floater.wakeAt > 0.4) {
        floater.wakeAt = stepTime
        this.onWake?.(position.x, position.z, 0.3, -(0.008 + speed * 0.008))
      }
    }
  }

  /**
   * The held buoy: a spring toward the hand plus the water it is pushed through. Moving wet it
   * sends a wake, plunging in or tearing out throws spray, and a fast drag throws spray too.
   */
  private applyHeldForces(floater: Floater, stepTime: number, wind: WindState) {
    const { body, radius, mass } = floater
    const position = body.translation()
    const velocity = body.linvel()
    const [surface, , , dhdt] = this.surfaceAt(position.x, position.z, stepTime, wind, radius)
    const index = lakeIndex(this.bed, position.x, position.z)
    const afloat = index >= 0 && sampleShore(this.bed, position.x, position.z) > 0
    const wet = afloat
      ? Math.max(0, Math.min(1, (surface - position.y + radius) / (2 * radius)))
      : 0
    const target = this.grabTarget
    body.addForce(
      {
        x: grabAcceleration(target.x - position.x, velocity.x, 0, wet, false) * mass,
        y: grabAcceleration(target.y - position.y, velocity.y, dhdt, wet, true) * mass,
        z: grabAcceleration(target.z - position.z, velocity.z, 0, wet, false) * mass,
      },
      true,
    )
    const speed = Math.hypot(velocity.x, velocity.z)
    // Clear of the water by a margin: bobbing on a wave while dragged along the surface must not
    // count as tearing out and plunging back, which threw a ring and a splash at every bob.
    const clear = position.y - radius > surface + HELD_CLEARANCE
    if (wet > 0 && floater.dry && velocity.y < -0.3) {
      // Plunged in: a ring and a splash, as for a drop.
      const energy = Math.min(0.8, -velocity.y * 0.18 + speed * 0.08)
      this.onWake?.(position.x, position.z, 0.15 + radius * 2, -energy * 0.1)
      this.splashes.spawnBurst(position.x, position.z, energy, stepTime, wind)
    } else if (clear && !floater.dry && velocity.y > 0.5) {
      // Torn out: the water it drags up falls back.
      const energy = Math.min(0.45, velocity.y * 0.14)
      this.onWake?.(position.x, position.z, 0.2 + radius, energy * 0.08)
      this.splashes.spawnBurst(position.x, position.z, energy, stepTime, wind)
    }
    // Dragged through the water it only lays a wake; spray is for plunging in and tearing out.
    this.layWake(floater, position.x, position.z, speed, wet)
    if (wet > 0) floater.dry = false
    else if (clear) floater.dry = true
  }

  /**
   * Spreads the held buoy's wake along the segment it moved this step: troughs whose depth
   * follows speed × immersion and whose sum follows the distance, so the trail is one smooth
   * furrow rather than a row of drops.
   */
  private layWake(floater: Floater, x: number, z: number, speed: number, wet: number) {
    const fromX = floater.trailX,
      fromZ = floater.trailZ
    floater.trailX = floater.trailZ = Number.NaN
    if (wet <= 0.05 || !Number.isFinite(x + z)) return
    floater.trailX = x
    floater.trailZ = z
    if (!Number.isFinite(fromX + fromZ)) return
    const length = Math.hypot(x - fromX, z - fromZ)
    if (length < 1e-4 || speed < 0.05) return
    const samples = Math.min(GRAB.wakeSamples, Math.ceil(length / GRAB.wakeSpacing))
    const share = length / samples / GRAB.wakeSpacing
    const depth = Math.min(1, wet * 1.6)
    const velocity = -Math.min(
      GRAB.wakeDepth,
      (GRAB.wakeFloor + speed * GRAB.wakeStrength) * depth * share,
    )
    for (let i = 1; i <= samples; i++) {
      const along = i / samples
      this.onWake?.(
        fromX + (x - fromX) * along,
        fromZ + (z - fromZ) * along,
        GRAB.wakeRadius,
        velocity,
      )
    }
  }

  private escaped(floater: Floater) {
    const { x, y, z } = floater.body.translation()
    return (
      !Number.isFinite(x + y + z) ||
      y < WATER_LEVEL - 2 ||
      y > 14 ||
      Math.abs(x) > LAKE_BOUNDS.size / 2 - 5 ||
      z < LAKE_BOUNDS.minZ + 5 ||
      z > 13
    )
  }

  private reset(floater: Floater, time: number, wind: WindState) {
    const surface = this.surfaceAt(floater.home.x, floater.home.z, time, wind, 0.08)[0]
    floater.body.setTranslation({ x: floater.home.x, y: surface + 0.15, z: floater.home.z }, true)
    floater.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    floater.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    floater.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true)
  }

  private place(index: number, floater: Floater) {
    const position = floater.body.translation()
    const rotation = floater.body.rotation()
    this.transform.position.set(position.x, position.y, position.z)
    this.transform.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
    const fade = Math.max(0, Math.min(1, (floater.fadeAt - this.time) / 4))
    this.transform.scale.set(
      floater.radius * fade,
      floater.radius * floater.flatten * fade,
      floater.radius * (floater.flatten < 1 ? 0.55 : 1) * fade,
    )
    this.transform.updateMatrix()
    this.mesh.setMatrixAt(index, this.transform.matrix)
  }

  /** Only the impact itself shoves a floater; travelling waves act through surface buoyancy. */
  splash(x: number, z: number, energy: number) {
    if (!Number.isFinite(x + z + energy) || energy <= 0) return
    const strength = Math.min(1, energy)
    for (const floater of this.floaters) {
      if (floater === this.held || floater.fadeAt <= this.time) continue
      const position = floater.body.translation()
      const dx = position.x - x,
        dz = position.z - z
      const distance = Math.hypot(dx, dz)
      const reach = 0.15 + strength * 0.2 + floater.radius
      if (distance >= reach) continue
      const nx = distance > 1e-4 ? dx / distance : 0,
        nz = distance > 1e-4 ? dz / distance : 0
      const falloff = 1 - distance / reach
      const impulse = floater.mass * strength * SPLASH_SPEED * falloff * falloff
      floater.body.applyImpulse({ x: nx * impulse, y: impulse * 0.6, z: nz * impulse }, true)
      // Solid-sphere inertia (2/5 m r²) spinning at half the rolling rate of the shove.
      const roll = 0.2 * impulse * floater.radius
      floater.body.applyTorqueImpulse({ x: nz * roll, y: 0, z: -nx * roll }, true)
    }
  }

  /** Per floater: waterline centre (x, z), circle radius and contact weight; unused slots are zero. */
  waterlines(out: readonly Vector4[]) {
    const wind = this.wind
    out.forEach((slot, i) => {
      const floater = this.floaters[i]
      if (!floater || !wind || floater.fadeAt <= this.time) {
        slot.set(0, 0, 0, 0)
        return
      }
      const { x, y, z } = floater.body.translation()
      const height = floater.radius * floater.flatten
      const offset = (this.surfaceAt(x, z, this.time, wind, floater.radius)[0] - y) / height
      slot.set(
        x,
        z,
        floater.radius * Math.sqrt(Math.max(0, 1 - offset * offset)),
        Math.abs(offset) < 1 ? 1 : 0,
      )
    })
  }

  update(time: number, wind: WindState, reducedMotion = false) {
    this.wind = wind
    this.time = time
    if (!reducedMotion) this.shedLeaf(time)
    this.floaters.forEach((floater, i) => {
      if (!reducedMotion && floater.fadeAt <= time) floater.body.setEnabled(false)
      if (!reducedMotion && floater !== this.held && this.escaped(floater)) {
        // Shed leaves that settle on land or leave the scene fade there, then recycle.
        if (floater.born > -Infinity) floater.fadeAt = Math.min(floater.fadeAt, time + 4)
        else this.reset(floater, time, wind)
      }
      this.place(i, floater)
    })
    this.mesh.instanceMatrix.needsUpdate = true
  }

  setWaterContact(contact: WaterContact) {
    this.contact = contact
  }

  dispose() {
    this.releaseGrab(true)
    this.releaseHook()
    for (const floater of this.floaters) this.physics.world.removeRigidBody(floater.body)
    this.floaters.length = 0
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
  }
}
