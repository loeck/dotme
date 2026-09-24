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
}>

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
      this.target.set(0, 0, 0)
      if (pointer) {
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

  get diagnostics(): Readonly<{ intensity: number; time: number }> {
    return { intensity: this.uniforms.uIntensity.value, time: this.uniforms.uTime.value }
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
