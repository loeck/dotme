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

/** Floaters strike terrain only: neither droplets, fish, nor each other. */
const FLOATER_GROUPS = (0x0002 << 16) | 0x0001
const GRAVITY = 9.81
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
    const specs: FloaterSpec[] = [
      { radius: 0.075, density: 500, windage: 0.25, flatten: 1, color: 0x91625a },
    ]
    const leaves = mobile ? 2 : 6
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
          .setCollisionGroups(FLOATER_GROUPS),
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
      this.grabTarget.copy(position)
      floater.body.setGravityScale(0, true)
      return position.clone()
    }
    return null
  }

  moveGrab(target: Vector3) {
    if (!this.held || !Number.isFinite(target.x + target.y + target.z)) return
    this.grabTarget.set(
      Math.max(-LAKE_BOUNDS.size / 2 + 6, Math.min(LAKE_BOUNDS.size / 2 - 6, target.x)),
      Math.max(WATER_LEVEL, Math.min(WATER_LEVEL + 6, target.y)),
      Math.max(LAKE_BOUNDS.minZ + 6, Math.min(12, target.z)),
    )
  }

  releaseGrab(cancelled = false) {
    const floater = this.held
    if (!floater) return
    this.held = null
    floater.body.setGravityScale(1, true)
    const velocity = this.point.copy(floater.body.linvel()).clampLength(0, 6)
    if (cancelled) velocity.set(0, 0, 0)
    floater.body.setLinvel(velocity, true)
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
    leaf.fadeAt = time + 45
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
        const force = (delta: number, speed: number) =>
          Math.max(-100, Math.min(100, delta * 180 - speed * 26)) * floater.mass
        body.addForce(
          {
            x: force(this.grabTarget.x - position.x, velocity.x),
            y: force(this.grabTarget.y - position.y, velocity.y),
            z: force(this.grabTarget.z - position.z, velocity.z),
          },
          true,
        )
        floater.dry =
          position.y >
          this.surfaceAt(position.x, position.z, stepTime, wind, floater.radius)[0] + floater.radius
        continue
      }
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
        const submerged = Math.max(
          0,
          Math.min(1, (surface - y + floater.radius) / (2 * floater.radius)),
        )
        wet += submerged * share
        if (submerged <= 0) continue
        const pointVx = velocity.x + angular.y * oz - angular.z * oy
        const pointVy = velocity.y + angular.z * ox - angular.x * oz
        const pointVz = velocity.z + angular.x * oy - angular.y * ox
        body.addForceAtPoint(
          {
            x: push(
              (-dx * GRAVITY * 0.9 + (driftX * floater.windage - pointVx) * 1.2) *
                submerged *
                share,
            ),
            y: push((2 * GRAVITY - (pointVy - dhdt) * 4) * submerged * share),
            z: push(
              (-dz * GRAVITY * 0.9 + (driftZ * floater.windage - pointVz) * 1.2) *
                submerged *
                share,
            ),
          },
          { x, y, z },
          false,
        )
      }
      if (wet === 0 && floater.flatten < 1) {
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
