import {
  AdditiveBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three'
import type { Camera, Scene } from 'three'

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

const VERTEX = `
attribute vec3 aCenter;
attribute vec3 aMotion;
uniform float uTime;
varying vec2 vUv;
varying float vPulse;
void main() {
  vUv = uv;
  float phase = aMotion.x;
  vPulse = 0.14 + pow(max(0.0, 0.5 + 0.5 * sin(uTime * 0.68 + phase)), 3.0) * 0.86;
  // View-space expansion uses the active camera, so reflected fireflies keep
  // their circular glow instead of becoming edge-on planes.
  vec4 viewCenter = viewMatrix * vec4(aCenter, 1.0);
  viewCenter.xy += position.xy * aMotion.z;
  gl_Position = projectionMatrix * viewCenter;
}
`

const FRAGMENT = `
uniform float uIntensity;
varying vec2 vUv;
varying float vPulse;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float radius = dot(p, p);
  float edge = 1.0 - smoothstep(0.65, 1.0, radius);
  float core = exp(-radius * 75.0);
  float halo = exp(-radius * 5.8) * 0.13;
  float glow = (core + halo) * edge * vPulse * uIntensity;
  if (glow < 0.00001) discard;
  gl_FragColor = vec4(mix(vec3(1.0, 0.48, 0.09), vec3(1.0, 0.84, 0.37), core), glow);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** Small seeded shoreline colonies, pooled in one GPU draw without local lights. */
export class LakeFireflies {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>
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
        bed.depth[i]! > 0.55 &&
        bed.depth[i]! < 1.8 &&
        bed.obstacle[i]! < WATER_LEVEL &&
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
        if (Math.hypot(x - groups[j]!, z - groups[j + 1]!) < 6) crowded = true
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
    geometry.setAttribute('position', plane.attributes.position!)
    geometry.setAttribute('uv', plane.attributes.uv!)
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
    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      forceSinglePass: true,
    })
    this.mesh = new Mesh(geometry, material)
    this.mesh.name = 'lake-fireflies'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 3
    scene.add(this.mesh)
  }

  update(time: number, wind: WindState, options: LakeFirefliesOptions = {}) {
    const uniforms = this.mesh.material.uniforms
    const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(0.05, time - this.lastTime))
    if (this.lastTime === null && options.nightFactor === undefined) this.arrival = 1
    this.lastTime = time
    const night = Math.max(0, Math.min(1, options.nightFactor ?? 1))
    this.arrival = fadeNightLight(this.arrival, night, dt, options.reducedMotion)
    uniforms.uTime!.value = options.reducedMotion ? 0 : time
    this.updatePositions(options.reducedMotion ? 0 : time, dt, wind, options)
    // Stay luminous while travelling; fade only at the distant end of the path.
    const visibility = options.reducedMotion ? night : smooth(0, 0.3, this.arrival)
    const target = visibility * Math.max(0, Math.min(1, options.intensity ?? 1))
    uniforms.uIntensity!.value = fadeNightLight(
      uniforms.uIntensity!.value,
      target,
      dt,
      options.reducedMotion,
    )
    this.mesh.visible = this.mesh.geometry.instanceCount > 0 && uniforms.uIntensity!.value > 0
  }

  private updatePositions(
    time: number,
    dt: number,
    wind: WindState,
    options: LakeFirefliesOptions,
  ) {
    const attribute = this.mesh.geometry.getAttribute('aCenter') as InstancedBufferAttribute
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
    for (let i = 0; i < attribute.count; i++) {
      const start = i * 3
      const phase = this.motions[start]!
      const flightTime = time * this.motions[start + 1]!
      this.center.set(
        this.origins[start]! +
          Math.sin(flightTime * 0.71 + phase) * 0.52 +
          Math.sin(windX * 0.028 + phase) * 0.24,
        this.origins[start + 1]! + Math.sin(flightTime + phase * 1.7) * 0.22,
        this.origins[start + 2]! +
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
            const worldPerPixel = (2 * depth) / (Math.abs(projection[5]!) * pointer.height)
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
        const offset = this.offsets[index]! - target
        const velocity = this.velocities[index]!
        // Exact critically damped spring for a fixed target over this frame.
        // It preserves velocity on entry, exit and direction reversals.
        const change = velocity + spring * offset
        this.offsets[index] = target + (offset + change * dt) * decay
        this.velocities[index] = (velocity - spring * change * dt) * decay
      }
      attribute.setXYZ(
        i,
        this.center.x + this.offsets[start]!,
        this.center.y + this.offsets[start + 1]!,
        this.center.z + this.offsets[start + 2]!,
      )
    }
    attribute.needsUpdate = true
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
  }
}
