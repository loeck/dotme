import {
  attribute,
  cameraViewMatrix,
  cameraProjectionMatrix,
  positionLocal,
  uniform,
  uv,
  vec4,
  vec3,
  float,
  sin,
  exp,
  mix,
  smoothstep,
  max,
} from 'three/tsl'
import {
  AdditiveBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu'
import type { Camera, Scene } from 'three/webgpu'

import { required } from '../invariant'
import { LAKE_BOUNDS, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { fadeNightLight } from './lighting'
import type { WindState } from './wind'

const smooth = (start: number, end: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)))
  return t * t * (3 - 2 * t)
}

export type FireflyPointer = Readonly<{
  ndc: Readonly<{ x: number; y: number }>
  camera: Camera
  /** CSS pixels, independent of the renderer's device-pixel ratio. */
  width: number
  height: number
}>

export type LakeFirefliesOptions = Readonly<{
  reducedMotion?: boolean
  nightFactor?: number
  intensity?: number
  pointer?: FireflyPointer | null
  /** Where a still cursor gathers the nearby flies at night; null lets them go home. */
  gather?: Readonly<{ x: number; y: number; z: number }> | null
}>

/** Flies within this many metres of a still cursor come to it. */
export const GATHER_REACH = 18
/** Rates, per second, at which a fly joins the swarm and leaves it. */
const GATHER_JOIN = 0.45
const GATHER_LEAVE = 1.2

/** Small seeded shoreline colonies, pooled in one GPU draw without local lights. */
export class LakeFireflies {
  readonly mesh: Mesh<InstancedBufferGeometry, MeshBasicNodeMaterial>
  private readonly uniforms = { uTime: uniform(0), uIntensity: uniform(0) }
  private lastTime: number | null = null
  private arrival = 0
  private readonly origins: Float32Array
  private readonly motions: Float32Array
  private readonly offsets: Float64Array
  private readonly velocities: Float64Array
  private readonly center = new Vector3()
  private readonly viewCenter = new Vector3()
  private readonly projected = new Vector3()
  private readonly target = new Vector3()
  private readonly cameraRight = new Vector3()
  private readonly cameraUp = new Vector3()
  /** Per fly, 0 on its own flight path, 1 circling the cursor. */
  private readonly gathered: Float64Array
  private readonly gatherPoint = new Vector3()
  private hasGatherPoint = false

  constructor(scene: Scene, bed: LakeBed, seed: number, mobile: boolean) {
    let state = (seed ^ 0xb017fa11) >>> 0
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
    const cell = LAKE_BOUNDS.size / bed.resolution
    const candidates: number[] = []
    for (let i = 0; i < bed.water.length; i += 3) {
      const x = LAKE_BOUNDS.minX + ((i % bed.resolution) + 0.5) * cell
      const z = LAKE_BOUNDS.minZ + (Math.floor(i / bed.resolution) + 0.5) * cell
      if (
        bed.water[i] &&
        required(bed.depth[i]) > 0.55 &&
        required(bed.depth[i]) < 1.8 &&
        required(bed.obstacle[i]) < WATER_LEVEL &&
        Math.abs(x) < 48 &&
        z > -60 &&
        z < 9
      )
        candidates.push(i)
    }
    const centers: number[] = [],
      motions: number[] = [],
      groups: number[] = []
    const groupBudget = mobile ? 3 : 8
    for (let attempt = 0; attempt < 100 && groups.length / 2 < groupBudget; attempt++) {
      const index = candidates[Math.floor(random() * candidates.length)]
      if (index === undefined) break
      const x = LAKE_BOUNDS.minX + ((index % bed.resolution) + 0.5) * cell
      const z = LAKE_BOUNDS.minZ + (Math.floor(index / bed.resolution) + 0.5) * cell
      let crowded = false
      for (let j = 0; j < groups.length; j += 2) {
        if (Math.hypot(x - required(groups[j]), z - required(groups[j + 1])) < 6) crowded = true
      }
      if (crowded) continue
      groups.push(x, z)
      for (let i = 0; i < 6; i++) {
        centers.push(x + (random() - 0.5) * 1.3, 0.55 + random() * 1.1, z + (random() - 0.5) * 1.3)
        motions.push(random() * Math.PI * 2, 0.3 + random() * 0.35, 0.22 + random() * 0.18)
      }
    }
    const plane = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.index = plane.index
    geometry.setAttribute('position', required(plane.attributes.position))
    geometry.setAttribute('uv', required(plane.attributes.uv))
    this.origins = new Float32Array(centers)
    this.motions = new Float32Array(motions)
    this.offsets = new Float64Array(centers.length)
    this.velocities = new Float64Array(centers.length)
    this.gathered = new Float64Array(centers.length / 3)
    geometry.setAttribute(
      'aCenter',
      new InstancedBufferAttribute(this.origins.slice(), 3).setUsage(DynamicDrawUsage),
    )
    geometry.setAttribute('aMotion', new InstancedBufferAttribute(this.motions, 3))
    geometry.instanceCount = centers.length / 3
    plane.dispose()
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      forceSinglePass: true,
    })
    const motion = attribute('aMotion', 'vec3')
    const center = cameraViewMatrix.mul(vec4(attribute('aCenter', 'vec3'), 1))
    material.vertexNode = cameraProjectionMatrix.mul(
      vec4(center.xy.add(positionLocal.xy.mul(motion.z)), center.z, center.w),
    )
    const pulse = max(0, sin(this.uniforms.uTime.mul(0.68).add(motion.x)).mul(0.5).add(0.5))
      .pow(3)
      .mul(0.86)
      .add(0.14)
    const p = uv().sub(0.5).mul(2),
      radius = p.dot(p)
    const core = exp(radius.mul(-75))
    const glow = core
      .add(exp(radius.mul(-5.8)).mul(0.13))
      .mul(float(1).sub(smoothstep(0.65, 1, radius)))
      .mul(pulse)
      .mul(this.uniforms.uIntensity)
    material.colorNode = mix(vec3(1, 0.48, 0.09), vec3(1, 0.84, 0.37), core)
    material.opacityNode = glow
    this.mesh = new Mesh(geometry, material)
    this.mesh.name = 'lake-fireflies'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3
    scene.add(this.mesh)
  }

  update(time: number, wind: WindState, options: LakeFirefliesOptions = {}) {
    const uniforms = this.uniforms
    const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(0.05, time - this.lastTime))
    if (this.lastTime === null && options.nightFactor === undefined) this.arrival = 1
    this.lastTime = time
    const night = Math.max(0, Math.min(1, options.nightFactor ?? 1))
    this.arrival = fadeNightLight(this.arrival, night, dt, options.reducedMotion)
    required(uniforms.uTime).value = options.reducedMotion ? 0 : time
    this.updatePositions(options.reducedMotion ? 0 : time, dt, wind, options)
    // Stay luminous while travelling; fade only at the distant end of the path.
    const visibility = options.reducedMotion ? night : smooth(0, 0.3, this.arrival)
    const target = visibility * Math.max(0, Math.min(1, options.intensity ?? 1))
    required(uniforms.uIntensity).value = fadeNightLight(
      required(uniforms.uIntensity).value,
      target,
      dt,
      options.reducedMotion,
    )
    this.mesh.visible =
      this.mesh.geometry.instanceCount > 0 && required(uniforms.uIntensity).value > 0
  }

  /**
   * Blends fly `i` from its flight path toward a small orbit round the gather point: each fly
   * keeps its own radius, height and pace, so the swarm turns as a loose ball, not a ring.
   */
  private swarmAround(
    i: number,
    phase: number,
    time: number,
    dt: number,
    gather: Readonly<{ x: number; y: number; z: number }> | null,
  ) {
    const near =
      gather !== null &&
      Math.hypot(this.center.x - gather.x, this.center.z - gather.z) < GATHER_REACH
    const weight = this.gathered[i] ?? 0
    const goal = near ? 1 : 0
    const rate = goal > weight ? GATHER_JOIN : GATHER_LEAVE
    const next = weight + (goal - weight) * (1 - Math.exp(-rate * dt))
    this.gathered[i] = next < 0.001 ? 0 : next
    if (this.gathered[i] === 0 || !this.hasGatherPoint) return
    const pace = 0.5 + 0.4 * Math.sin(phase * 3.1)
    const angle = time * pace + phase * 2.3
    const radius = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase * 5.7))
    const point = this.gatherPoint
    const s = smooth(0, 1, this.gathered[i] ?? 0)
    this.center.set(
      this.center.x + (point.x + Math.cos(angle) * radius - this.center.x) * s,
      this.center.y + (point.y + Math.sin(time * 0.9 + phase) * 0.35 - this.center.y) * s,
      this.center.z + (point.z + Math.sin(angle) * radius - this.center.z) * s,
    )
  }

  private updatePositions(
    time: number,
    dt: number,
    wind: WindState,
    options: LakeFirefliesOptions,
  ) {
    const centers = this.mesh.geometry.getAttribute('aCenter')
    const input = options.reducedMotion ? null : options.pointer
    const pointer =
      input &&
      input.width > 0 &&
      input.height > 0 &&
      Number.isFinite(input.ndc.x) &&
      Number.isFinite(input.ndc.y)
        ? input
        : null
    if (pointer) {
      this.cameraRight.setFromMatrixColumn(pointer.camera.matrixWorld, 0)
      this.cameraUp.setFromMatrixColumn(pointer.camera.matrixWorld, 1)
    }
    if (options.reducedMotion) {
      this.offsets.fill(0)
      this.velocities.fill(0)
    }
    const windX = options.reducedMotion ? 0 : wind.displacement[0]
    const windZ = options.reducedMotion ? 0 : wind.displacement[1]
    const spring = 9
    const decay = Math.exp(-spring * dt)
    const gather = options.reducedMotion ? null : (options.gather ?? null)
    if (gather) this.gatherPoint.set(gather.x, gather.y, gather.z)
    this.hasGatherPoint = this.hasGatherPoint || gather !== null
    for (let i = 0; i < centers.count; i++) {
      const start = i * 3
      const phase = required(this.motions[start])
      const flightTime = time * required(this.motions[start + 1])
      this.center.set(
        required(this.origins[start]) +
          Math.sin(flightTime * 0.71 + phase) * 0.52 +
          Math.sin(windX * 0.028 + phase) * 0.24,
        required(this.origins[start + 1]) + Math.sin(flightTime + phase * 1.7) * 0.22,
        required(this.origins[start + 2]) +
          Math.cos(flightTime * 0.53 + phase) * 0.38 +
          Math.sin(windZ * 0.028 + phase) * 0.24,
      )
      if (!options.reducedMotion) {
        // Each particle has its own elevated approach/escape route. A continuous
        // night weight allows sunrise/sunset reversals without teleporting.
        const delay = (0.5 + 0.5 * Math.sin(phase * 2.7)) * 0.18
        const travel = 1 - smooth(delay, 0.82 + delay, this.arrival)
        const angle = phase + i * 2.399963
        const distance = travel * (7 + 5 * (0.5 + 0.5 * Math.sin(phase * 1.3)))
        const bend = Math.sin(travel * Math.PI) * 1.2
        this.center.x += Math.cos(angle) * distance - Math.sin(angle) * bend
        this.center.z += Math.sin(angle) * distance + Math.cos(angle) * bend
        this.center.y += travel * (3.5 + 3 * (0.5 + 0.5 * Math.cos(phase)))
      }
      this.swarmAround(i, phase, time, dt, gather)
      this.target.set(0, 0, 0)
      if (pointer && !gather) {
        this.viewCenter.copy(this.center).applyMatrix4(pointer.camera.matrixWorldInverse)
        this.projected.copy(this.viewCenter).applyMatrix4(pointer.camera.projectionMatrix)
        // Measure from the unrepelled flight path. Measuring the displaced pose
        // would feed the response back into its own force and make flies jitter.
        if (this.viewCenter.z < 0 && this.projected.z >= -1 && this.projected.z <= 1) {
          const dx = ((this.projected.x - pointer.ndc.x) * pointer.width) / 2
          const dy = ((this.projected.y - pointer.ndc.y) * pointer.height) / 2
          const distance = Math.hypot(dx, dy)
          if (distance < 70) {
            const t = distance / 70
            const falloff = 1 - t * t * (3 - 2 * t)
            const projection = pointer.camera.projectionMatrix.elements
            const depth = projection[15] === 0 ? -this.viewCenter.z : 1
            const worldPerPixel = (2 * depth) / (Math.abs(required(projection[5])) * pointer.height)
            const reach = Math.min(0.5, worldPerPixel * 22) * falloff
            const softDistance = Math.sqrt(dx * dx + dy * dy + 12 * 12)
            this.target
              .copy(this.cameraRight)
              .multiplyScalar((dx / softDistance) * reach)
              .addScaledVector(this.cameraUp, (dy / softDistance) * reach + 0.04 * falloff)
          }
        }
      }
      for (let axis = 0; axis < 3; axis++) {
        const index = start + axis
        const target = this.target.getComponent(axis)
        const offset = required(this.offsets[index]) - target
        const velocity = required(this.velocities[index])
        // Exact critically damped spring for a fixed target over this frame.
        // It preserves velocity on entry, exit and direction reversals.
        const change = velocity + spring * offset
        this.offsets[index] = target + (offset + change * dt) * decay
        this.velocities[index] = (velocity - spring * change * dt) * decay
      }
      centers.setXYZ(
        i,
        this.center.x + required(this.offsets[start]),
        this.center.y + required(this.offsets[start + 1]),
        this.center.z + required(this.offsets[start + 2]),
      )
    }
    centers.needsUpdate = true
  }

  /** How many flies are at least half-way into the swarm. */
  get swarm() {
    let count = 0
    for (const weight of this.gathered) if (weight > 0.5) count++
    return count
  }

  /**
   * A click scatters the swarm: each gathered fly darts away from the cursor, then drifts back
   * to its own flight path as the swarm lets go.
   */
  scatter() {
    if (!this.hasGatherPoint) return
    const centers = this.mesh.geometry.getAttribute('aCenter')
    for (let i = 0; i < this.gathered.length; i++) {
      const weight = this.gathered[i] ?? 0
      if (weight < 0.05) continue
      const dx = centers.getX(i) - this.gatherPoint.x,
        dy = centers.getY(i) - this.gatherPoint.y,
        dz = centers.getZ(i) - this.gatherPoint.z
      const length = Math.hypot(dx, dy, dz) || 1
      // The flight-path spring is stiff: a strong kick still travels only a metre or so.
      const speed = 25 * weight
      this.velocities[i * 3] = (this.velocities[i * 3] ?? 0) + (dx / length) * speed
      this.velocities[i * 3 + 1] =
        (this.velocities[i * 3 + 1] ?? 0) + (dy / length) * speed + weight
      this.velocities[i * 3 + 2] = (this.velocities[i * 3 + 2] ?? 0) + (dz / length) * speed
    }
  }

  get diagnostics(): Readonly<{ intensity: number; time: number }> {
    return { intensity: this.uniforms.uIntensity.value, time: this.uniforms.uTime.value }
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
