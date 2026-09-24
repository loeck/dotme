import {
  Fn,
  If,
  attribute,
  float,
  vec2,
  vec4,
  uv,
  texture,
  positionLocal,
  min,
  smoothstep,
  exp,
  clamp,
  uniform,
} from 'three/tsl'
import {
  AdditiveBlending,
  DoubleSide,
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  Scene,
  Vector4,
  RenderTarget,
} from 'three/webgpu'
import type { WebGPURenderer } from 'three/webgpu'

import { LAKE_BOUNDS, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { prepareWaterMask } from './lake-geometry-data'
import type { PreparedWaterMask } from './lake-geometry-data'
import { createWindNodes, windFieldNode } from './water-surface'
import { WindModel, updateWindUniforms } from './wind'

export const WATER_STEP = 1 / 60
export const WAVE_SPEED = 2.4
export const WATER_DAMPING = 0.65
export const MAX_WATER_STEPS = 4

export { prepareWaterMask as createWaterMask } from './lake-geometry-data'

/** Shared clock: fixed physical time, bounded recovery after a hidden tab. */
export class WaterClock {
  private remainder = 0
  advance(delta: number) {
    this.remainder += Math.max(0, Math.min(delta, WATER_STEP * MAX_WATER_STEPS))
    const steps = Math.min(MAX_WATER_STEPS, Math.floor((this.remainder + 1e-9) / WATER_STEP))
    this.remainder -= steps * WATER_STEP
    return steps
  }
  get pendingTime() {
    return this.remainder
  }
  reset() {
    this.remainder = 0
  }
}

/** GPU-resident fragment passes advance the shared fixed-step water field. */
export class WaterSimulation {
  readonly resolution: number
  readonly available = true
  readonly channels = 4
  readonly mask: DataTexture
  private readonly targets: [RenderTarget, RenderTarget]
  private current: 0 | 1 = 0
  private readonly clock = new WaterClock()
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly material = new MeshBasicNodeMaterial({
    side: DoubleSide,
    forceSinglePass: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly splat = new MeshBasicNodeMaterial({
    side: DoubleSide,
    forceSinglePass: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    blending: AdditiveBlending,
    toneMapped: false,
  })
  private readonly quad: Mesh
  private readonly pending: Vector4[] = []
  private readonly splatGeometry = new InstancedBufferGeometry()
  private readonly impulses = new InstancedBufferAttribute(new Float32Array(128 * 4), 4).setUsage(
    DynamicDrawUsage,
  )
  private readonly splatMesh: Mesh
  private disposed = false
  private readonly windUniforms = createWindNodes()
  private readonly windContact = uniform(0)
  private readonly stateNode

  private readonly renderer: WebGPURenderer
  private readonly bed: LakeBed
  private readonly wind: WindModel
  constructor(
    renderer: WebGPURenderer,
    bed: LakeBed,
    mobile: boolean,
    wind = new WindModel(0),
    preparedMask: PreparedWaterMask = prepareWaterMask(bed),
  ) {
    this.renderer = renderer
    this.bed = bed
    this.wind = wind
    this.resolution = mobile ? 512 : 1024
    const mask = preparedMask
    this.mask = new DataTexture(mask.water, mask.resolution, mask.resolution, RedFormat)
    this.mask.minFilter = this.mask.magFilter = NearestFilter
    this.mask.needsUpdate = true
    const dx = LAKE_BOUNDS.size / this.resolution
    if ((WAVE_SPEED * WATER_STEP) / dx > Math.SQRT1_2) throw new Error('Unstable water time step')
    const makeTarget = () =>
      new RenderTarget(this.resolution, this.resolution, {
        type: HalfFloatType,
        format: RGBAFormat,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      })
    this.targets = [makeTarget(), makeTarget()]
    this.stateNode = texture(this.targets[0].texture)
    const maskNode = texture(this.mask)
    // TSL texture UVs start at the top. Match the output
    // orientation or ping-pong would mirror the field on every odd step.
    this.material.vertexNode = vec4(positionLocal.x, positionLocal.y.negate(), 0, 1)
    this.material.fragmentNode = Fn(() => {
      const coordinate = uv()
      const state = this.stateNode.sample(coordinate)
      const wall = vec2(0).toVar()
      const laplacian = state.x.mul(-20).toVar()
      for (const [ox, oy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
      ] as const) {
        const weight = ox === 0 || oy === 0 ? 4 : 1
        const adjacent = coordinate.add(vec2(ox, oy).div(this.resolution))
        const neighbor = state.x.toVar()
        If(maskNode.sample(adjacent).r.greaterThanEqual(0.5), () => {
          neighbor.assign(this.stateNode.sample(adjacent).r)
        }).Else(() => {
          wall.subAssign(vec2(ox, oy).mul(weight / 6))
        })
        laplacian.addAssign(neighbor.mul(weight))
      }
      laplacian.divAssign(6)
      If(this.windContact.greaterThan(0).and(wall.dot(wall).greaterThan(0.001)), () => {
        const p = coordinate.mul(LAKE_BOUNDS.size).add(vec2(LAKE_BOUNDS.minX, LAKE_BOUNDS.minZ))
        laplacian.addAssign(
          windFieldNode(p, float(dx), this.windUniforms).yz.dot(wall).mul(dx).mul(this.windContact),
        )
      })
      const edge = min(
        min(coordinate.x, coordinate.y),
        min(float(1).sub(coordinate.x), float(1).sub(coordinate.y)),
      )
      const sponge = float(1).sub(smoothstep(0, 0.055, edge))
      const decay = exp(sponge.mul(16).add(WATER_DAMPING).mul(-WATER_STEP))
      const velocity = state.y
        .add(laplacian.mul((WAVE_SPEED ** 2 * WATER_STEP) / dx ** 2))
        .mul(decay)
      const height = state.x.add(velocity.mul(WATER_STEP)).mul(exp(sponge.mul(-8 * WATER_STEP)))
      return maskNode
        .sample(coordinate)
        .r.greaterThanEqual(0.5)
        .select(vec4(clamp(height, -0.22, 0.22), clamp(velocity, -1.5, 1.5), 0, 0), vec4(0))
    })()
    const impulse = attribute('aImpulse', 'vec4')
    const splatPosition = impulse.xy.mul(2).sub(1).add(positionLocal.xy.mul(impulse.z).mul(2))
    this.splat.vertexNode = vec4(splatPosition.x, splatPosition.y.negate(), 0, 1)
    const p = uv().sub(0.5).mul(2)
    const q = p.dot(p)
    const profile = q.lessThan(1).select(
      float(1)
        .sub(q)
        .pow(2)
        .mul(float(1).sub(q.mul(4))),
      float(0),
    )
    this.splat.fragmentNode = vec4(
      0,
      impulse.w.mul(profile).mul(
        maskNode
          .sample(impulse.xy.add(p.mul(impulse.z)))
          .r.greaterThanEqual(0.5)
          .select(1, 0),
      ),
      0,
      1,
    )
    this.quad = new Mesh(this.geometry, this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
    this.splatGeometry.index = this.geometry.index
    this.splatGeometry.setAttribute('position', this.geometry.getAttribute('position'))
    this.splatGeometry.setAttribute('uv', this.geometry.getAttribute('uv'))
    this.splatGeometry.setAttribute('aImpulse', this.impulses)
    this.splatMesh = new Mesh(this.splatGeometry, this.splat)
    this.splatMesh.frustumCulled = false
    this.splatMesh.visible = false
    this.scene.add(this.splatMesh)
    this.reset()
  }

  async compileAsync() {
    const previous = this.renderer.getRenderTarget()
    let compiled: Promise<void>
    this.splatMesh.visible = true
    try {
      this.renderer.setRenderTarget(this.targets[this.current])
      compiled = this.renderer.compileAsync(this.scene, this.camera)
    } finally {
      this.renderer.setRenderTarget(previous)
      this.splatMesh.visible = false
    }
    await compiled
  }

  get texture() {
    return this.targets[this.current].texture
  }

  addImpulse(x: number, z: number, radius: number, velocity: number) {
    if (this.disposed || this.pending.length >= 128) return
    const index = lakeIndex(this.bed, x, z)
    if (index < 0 || !this.bed.water[index]) return
    this.pending.push(
      new Vector4(
        (x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size,
        (z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size,
        Math.max(radius, (LAKE_BOUNDS.size / this.resolution) * 2.5) / LAKE_BOUNDS.size,
        Math.max(-0.65, Math.min(0.65, velocity)),
      ),
    )
  }

  step(delta: number, windTime?: number) {
    if (this.disposed) return
    const steps = this.clock.advance(delta)
    if (!steps) return
    const previous = this.renderer.getRenderTarget(),
      autoClear = this.renderer.autoClear
    try {
      this.renderer.autoClear = false
      this.renderer.setRenderTarget(this.targets[this.current])
      if (this.pending.length) {
        this.pending.forEach((impulse, i) => impulse.toArray(this.impulses.array, i * 4))
        this.impulses.needsUpdate = true
        this.splatGeometry.instanceCount = this.pending.length
        this.quad.visible = false
        this.splatMesh.visible = true
        this.renderer.render(this.scene, this.camera)
      }
      this.pending.length = 0
      this.splatMesh.visible = false
      this.quad.visible = true
      for (let i = 0; i < steps; i++) {
        const time = (windTime ?? 0) - this.clock.pendingTime - (steps - i - 1) * WATER_STEP
        this.windUniforms.uTime.value = time
        updateWindUniforms(this.windUniforms, this.wind.sample(time))
        this.windContact.value = windTime === undefined ? 0 : 1
        this.stateNode.value = this.texture
        const next = this.current === 0 ? 1 : 0
        this.renderer.setRenderTarget(this.targets[next])
        this.renderer.render(this.scene, this.camera)
        this.current = next
      }
    } finally {
      this.splatMesh.visible = false
      this.quad.visible = true
      this.renderer.autoClear = autoClear
      this.renderer.setRenderTarget(previous)
    }
  }

  async heightAt(x: number, z: number) {
    if (this.disposed) return 0
    const px = Math.floor(((x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size) * this.resolution)
    const pz = Math.floor(((z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size) * this.resolution)
    if (px < 0 || pz < 0 || px >= this.resolution || pz >= this.resolution) return 0
    const data = await this.renderer.readRenderTargetPixelsAsync(
      this.targets[this.current],
      px,
      pz,
      1,
      1,
    )
    const height = data[0] ?? 0
    return data instanceof Uint16Array ? DataUtils.fromHalfFloat(height) : height
  }

  /** Explicit diagnostics readback; the animation never copies the field to the CPU. */
  async snapshot() {
    if (this.disposed) throw new Error('Water simulation is disposed')
    const pixels = await this.renderer.readRenderTargetPixelsAsync(
      this.targets[this.current],
      0,
      0,
      this.resolution,
      this.resolution,
    )
    const state = new Float32Array(this.resolution * this.resolution * 2)
    for (let i = 0; i < this.resolution * this.resolution; i++) {
      // WebGPU readback preserves the field's top-to-bottom world-z ordering.
      const pixel = i * 4
      const height = pixels[pixel] ?? 0,
        velocity = pixels[pixel + 1] ?? 0
      state[i * 2] = pixels instanceof Uint16Array ? DataUtils.fromHalfFloat(height) : height
      state[i * 2 + 1] =
        pixels instanceof Uint16Array ? DataUtils.fromHalfFloat(velocity) : velocity
    }
    return { resolution: this.resolution, state }
  }

  reset() {
    if (this.disposed) return
    this.clock.reset()
    this.pending.length = 0
    const previous = this.renderer.getRenderTarget(),
      color = this.renderer.getClearColor(new Color()),
      alpha = this.renderer.getClearAlpha()
    try {
      this.renderer.setClearColor(0, 0)
      for (const target of this.targets) {
        this.renderer.setRenderTarget(target)
        this.renderer.clear()
      }
    } finally {
      this.renderer.setRenderTarget(previous)
      this.renderer.setClearColor(color, alpha)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const target of this.targets) target.dispose()
    this.mask.dispose()
    this.geometry.dispose()
    this.splatGeometry.dispose()
    this.material.dispose()
    this.splat.dispose()
    this.pending.length = 0
  }
}
