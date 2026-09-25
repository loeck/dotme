import type { RigidBody } from '@dimforge/rapier3d-compat'
import {
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  MeshStandardNodeMaterial,
  Object3D,
  SphereGeometry,
} from 'three/webgpu'
import type { Scene } from 'three/webgpu'

import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex, sampleShore } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { LakeSplashes } from './lake-splashes'
import type { PhysicsWorld } from './physics-world'
import { sampleWindField } from './water-surface'
import type { WindState } from './wind'

/** Floaters strike terrain only: neither droplets, fish, nor each other. */
const FLOATER_GROUPS = (0x0002 << 16) | 0x0001
const GRAVITY = 9.81
const LEAF_COLORS = [0x4a7c3a, 0x5d8f43, 0x3d6e33]

type Floater = {
  body: RigidBody
  radius: number
  mass: number
  windage: number
  flatten: number
  home: { x: number; z: number }
  wakeAt: number
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
  private wind: WindState | null = null
  private readonly releaseHook: () => void
  onWake?: (x: number, z: number, radius: number, velocity: number) => void
  private state: number
  private readonly physics: PhysicsWorld

  constructor(
    scene: Scene,
    bed: LakeBed,
    seed: number,
    mobile: boolean,
    physics: PhysicsWorld,
    splashes: LakeSplashes,
  ) {
    this.physics = physics
    this.state = (seed ^ 0x3f10a7) >>> 0
    const specs: FloaterSpec[] = [
      { radius: 0.09, density: 500, windage: 0.25, flatten: 1, color: 0xc23b2e },
    ]
    const leaves = mobile ? 2 : 6
    for (let i = 0; i < leaves; i++)
      specs.push({
        radius: 0.02,
        density: 350,
        windage: 1,
        flatten: 0.4,
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
      })
    }
    const geometry = new SphereGeometry(1, 12, 8)
    const material = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0 })
    this.mesh = new InstancedMesh(geometry, material, this.floaters.length)
    this.mesh.name = 'floating-bodies'
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.receiveShadow = true
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

  private applyStepForces(stepTime: number) {
    const wind = this.wind
    if (!wind) return
    const driftX = wind.direction[0] * wind.speed * 0.03
    const driftZ = wind.direction[1] * wind.speed * 0.03
    for (const floater of this.floaters) {
      const { body } = floater
      const position = body.translation()
      const velocity = body.linvel()
      const [height, dx, dz, dhdt] = sampleWindField(position.x, position.z, stepTime, wind, 0.08)
      const submerged = Math.max(
        0,
        Math.min(1, (WATER_LEVEL + height - position.y + floater.radius) / (2 * floater.radius)),
      )
      body.resetForces(false)
      if (submerged <= 0) continue
      const push = (value: number) =>
        Math.max(-40, Math.min(40, Number.isFinite(value) ? value : 0)) * floater.mass
      const surge = (drift: number, slope: number, speed: number) =>
        push(
          -slope * GRAVITY * 0.9 * submerged + (drift * floater.windage - speed) * 1.2 * submerged,
        )
      body.addForce(
        {
          x: surge(driftX, dx, velocity.x),
          y: push(submerged * 2 * GRAVITY - (velocity.y - dhdt) * 4),
          z: surge(driftZ, dz, velocity.z),
        },
        false,
      )
      const speed = Math.hypot(velocity.x, velocity.z)
      if (submerged > 0.3 && speed > 0.15 && stepTime - floater.wakeAt > 0.4) {
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
    const surface =
      WATER_LEVEL + sampleWindField(floater.home.x, floater.home.z, time, wind, 0.08)[0]
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
    this.transform.scale.set(floater.radius, floater.radius * floater.flatten, floater.radius)
    this.transform.updateMatrix()
    this.mesh.setMatrixAt(index, this.transform.matrix)
  }

  update(time: number, wind: WindState, reducedMotion = false) {
    this.wind = wind
    this.floaters.forEach((floater, i) => {
      if (!reducedMotion && this.escaped(floater)) this.reset(floater, time, wind)
      this.place(i, floater)
    })
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.releaseHook()
    for (const floater of this.floaters) this.physics.world.removeRigidBody(floater.body)
    this.floaters.length = 0
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
  }
}
