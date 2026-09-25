import {
  DoubleSide,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicNodeMaterial,
  Object3D,
  PlaneGeometry,
} from 'three/webgpu'
import type { Scene } from 'three/webgpu'

import { LAKE_BOUNDS, WATER_LEVEL, lakeIndex, sampleShore } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { sampleWindField } from './water-surface'
import type { WindState } from './wind'

const FOAM_STEP = 1 / 30
const MAX_FOAM_STEPS = 3
const smooth = (t: number) => t * t * (3 - 2 * t)

type Patch = {
  x: number
  z: number
  vx: number
  vz: number
  size: number
  seed: number
  born: number
  life: number
  active: boolean
}

/** Wind- and slope-drifted foam flecks collapsing softly against the shore field. */
export class FoamDrift {
  readonly mesh: InstancedMesh<PlaneGeometry, MeshBasicNodeMaterial>
  private readonly patches: Patch[] = []
  private readonly transform = new Object3D()
  private readonly bed: LakeBed
  private stepTime = 0
  private accumulator = 0
  private lastTime: number | null = null
  private state: number

  constructor(scene: Scene, bed: LakeBed, seed: number, mobile: boolean) {
    this.bed = bed
    this.state = (seed ^ 0x90e1c4) >>> 0
    const count = mobile ? 36 : 96
    for (let i = 0; i < count; i++) {
      const patch = this.spawn(0)
      patch.born = -this.random() * patch.life
      this.patches.push(patch)
    }
    const geometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    const material = new MeshBasicNodeMaterial({
      color: 0xf4faf9,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: DoubleSide,
    })
    this.mesh = new InstancedMesh(geometry, material, this.patches.length)
    this.mesh.name = 'drifting-foam'
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 4
    scene.add(this.mesh)
    this.sync(0)
  }

  private random() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0
    return this.state / 0x1_0000_0000
  }

  private spawn(time: number): Patch {
    for (let attempt = 0; attempt < 48; attempt++) {
      const x = LAKE_BOUNDS.minX + this.random() * LAKE_BOUNDS.size
      const z = LAKE_BOUNDS.minZ + this.random() * LAKE_BOUNDS.size
      const index = lakeIndex(this.bed, x, z)
      if (index < 0 || !this.bed.water[index]) continue
      if (this.random() < 0.7 && sampleShore(this.bed, x, z) > 2.5) continue
      return {
        x,
        z,
        vx: 0,
        vz: 0,
        size: 0.06 + this.random() ** 2 * 0.16,
        seed: this.random(),
        born: time,
        life: 6 + this.random() * 8,
        active: true,
      }
    }
    return { x: 0, z: 0, vx: 0, vz: 0, size: 0, seed: 0, born: time, life: 0, active: false }
  }

  private resolveShore(patch: Patch, distance: number) {
    const eps = 0.15
    let nx =
      sampleShore(this.bed, patch.x + eps, patch.z) - sampleShore(this.bed, patch.x - eps, patch.z)
    let nz =
      sampleShore(this.bed, patch.x, patch.z + eps) - sampleShore(this.bed, patch.x, patch.z - eps)
    const length = Math.hypot(nx, nz)
    if (length < 1e-4) {
      nx = 1
      nz = 0
    } else {
      nx /= length
      nz /= length
    }
    patch.x += nx * (0.03 - distance)
    patch.z += nz * (0.03 - distance)
    const inward = patch.vx * nx + patch.vz * nz
    if (inward < 0) {
      patch.vx -= nx * inward
      patch.vz -= nz * inward
    }
    patch.size *= 1 - FOAM_STEP * 0.5
  }

  private step(wind: WindState) {
    this.stepTime += FOAM_STEP
    const driftX = wind.direction[0] * wind.speed * 0.05
    const driftZ = wind.direction[1] * wind.speed * 0.05
    const relax = Math.min(1, FOAM_STEP * 1.2)
    this.patches.forEach((patch, i) => {
      if (!patch.active) return
      if (this.stepTime - patch.born > patch.life || patch.size < 0.03) {
        this.patches[i] = this.spawn(this.stepTime)
        return
      }
      const [, dx, dz] = sampleWindField(patch.x, patch.z, this.stepTime, wind, 0.05)
      patch.vx += (driftX - dx * 0.5 - patch.vx) * relax
      patch.vz += (driftZ - dz * 0.5 - patch.vz) * relax
      patch.x += patch.vx * FOAM_STEP
      patch.z += patch.vz * FOAM_STEP
      const distance = sampleShore(this.bed, patch.x, patch.z)
      if (distance < 0.03) this.resolveShore(patch, distance)
    })
  }

  private sync(time: number) {
    this.patches.forEach((patch, i) => {
      if (!patch.active) {
        this.transform.position.set(0, -100, 0)
        this.transform.rotation.set(0, 0, 0)
        this.transform.scale.setScalar(0)
      } else {
        const [height] = sampleWindField(patch.x, patch.z, time, undefined, 0.05)
        const age = Math.max(0, time - patch.born)
        const fade =
          smooth(Math.max(0, Math.min(1, age / 0.5))) *
          smooth(Math.max(0, Math.min(1, (patch.life - age) / 1.2)))
        this.transform.position.set(patch.x, WATER_LEVEL + height + 0.02, patch.z)
        this.transform.rotation.set(
          0,
          patch.seed * Math.PI * 2 + time * 0.1 * (patch.seed - 0.5),
          0,
        )
        this.transform.scale.setScalar(Math.max(0, patch.size * fade))
      }
      this.transform.updateMatrix()
      this.mesh.setMatrixAt(i, this.transform.matrix)
    })
    this.mesh.instanceMatrix.needsUpdate = true
  }

  update(time: number, wind: WindState, reducedMotion = false) {
    if (this.lastTime === null) this.stepTime = time
    const frameDelta = this.lastTime === null ? 0 : Math.max(0, Math.min(0.1, time - this.lastTime))
    this.lastTime = time
    if (reducedMotion) {
      this.sync(this.stepTime)
      return
    }
    this.accumulator = Math.min(this.accumulator + frameDelta, FOAM_STEP * MAX_FOAM_STEPS)
    const steps = Math.min(MAX_FOAM_STEPS, Math.floor((this.accumulator + 1e-9) / FOAM_STEP))
    this.accumulator = Math.max(0, this.accumulator - steps * FOAM_STEP)
    for (let i = 0; i < steps; i++) this.step(wind)
    this.sync(time)
  }

  dispose() {
    this.patches.length = 0
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.dispose()
  }
}
