import {
  Fn,
  If,
  Loop,
  clamp,
  dot,
  exp,
  float,
  instanceIndex,
  int,
  ivec2,
  min,
  normalize,
  transformNormalToView,
  positionLocal,
  smoothstep,
  texture,
  textureLoad,
  textureStore,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
  wgslFn,
} from 'three/tsl'
import {
  DataTexture,
  HalfFloatType,
  LinearFilter,
  MeshStandardNodeMaterial,
  NearestFilter,
  RedFormat,
  StorageTexture,
  Vector2,
  Vector4,
} from 'three/webgpu'
import type { Node, WebGPURenderer } from 'three/webgpu'

import { LAKE_BOUNDS, lakeIndex } from '../lake-bed'
import type { LakeBed } from '../lake-bed'
import { WaterClock, WATER_STEP, WAVE_SPEED, WATER_DAMPING } from '../water-simulation'
import { WAVE_SPECTRUM } from '../water-surface'
import { WindModel } from '../wind'

const literal = (value: number) => value.toFixed(9)
// Same coefficients and equations as WebGL; a native WGSL function is called
// through TSL in both the compute kernel and the experimental water material.
const windField =
  wgslFn(`fn prototypeWind(p: vec2<f32>, footprint: f32, time: f32, rotation: vec2<f32>, response: vec4<f32>) -> vec3<f32> {
  var field = vec3<f32>(0.0);
  ${WAVE_SPECTRUM.map(
    (w) => `if (footprint < ${literal(w.wavelength * 0.5)}) {
    let baseK = vec2<f32>(${literal(w.kx)}, ${literal(w.kz)});
    let k = vec2<f32>(baseK.x * rotation.x - baseK.y * rotation.y, baseK.x * rotation.y + baseK.y * rotation.x);
    let spatial = dot(p, k);
    let crossK = vec2<f32>(-k.y, k.x) * 0.18;
    let crossPhase = dot(p, crossK) + time * ${literal(w.omega * 0.025)} + ${literal(w.phase * 1.7)};
    let phase = spatial - time * ${literal(w.omega)} + ${literal(w.phase)} + 0.42 * sin(crossPhase * 0.57);
    let phaseGradient = k + crossK * 0.2394 * cos(crossPhase * 0.57);
    let groupPhase = spatial * 0.14 - time * ${literal(w.omega * 0.07)} + ${literal(w.phase * 2.3)};
    let alongPacket = 0.72 + 0.28 * cos(groupPhase);
    let crossPacket = 0.64 + 0.36 * cos(crossPhase);
    let packet = alongPacket * crossPacket;
    let packetGradient = -k * 0.0392 * sin(groupPhase) * crossPacket - crossK * 0.36 * sin(crossPhase) * alongPacket;
    let base = ${literal(w.amplitude)} * (1.0 - smoothstep(${literal(w.wavelength * 0.18)}, ${literal(w.wavelength * 0.5)}, footprint));
    let amplitude = base * (1.0 + ${literal(w.sensitivity)} * (mix(response.x, response.y, ${literal(w.small)}) - 1.0));
    field += vec3<f32>(sin(phase) * amplitude * packet, amplitude * (phaseGradient * cos(phase) * packet + sin(phase) * packetGradient));
  }`,
  ).join('\n')}
  return field;
}`)

/** Isolated WebGPU experiment. Never imported by the production WebGL engine.
 * GPU-resident ping-pong storage textures feed a TSL displacement material directly.
 * The optical material is a preview: it does not claim parity with lake-water.ts. */
export class WebGPUWaterSimulation {
  readonly resolution: number
  readonly mask: DataTexture
  private readonly targets: StorageTexture[]
  private readonly clock = new WaterClock()
  private readonly time = uniform(0)
  private readonly rotation = uniform(new Vector2(1, 0))
  private readonly response = uniform(new Vector4(1, 1, 0, 0))
  private readonly windContact = uniform(0)
  private readonly impulseCount = uniform(0, 'int')
  private readonly impulses = Array.from({ length: 128 }, () => new Vector4())
  private readonly impulseData = uniformArray<'vec4'>(this.impulses, 'vec4')
  private readonly integration
  private readonly splats
  private readonly resets
  readonly stateNode
  private current = 0
  private pending = 0
  private disposed = false

  static async create(
    renderer: WebGPURenderer,
    bed: LakeBed,
    mobile: boolean,
    wind = new WindModel(0),
  ) {
    if (!renderer.hasInitialized()) await renderer.init()
    if (!('isWebGPUBackend' in renderer.backend))
      throw new Error('The compute prototype requires WebGPU')
    return new WebGPUWaterSimulation(renderer, bed, mobile, wind)
  }

  private constructor(
    private readonly renderer: WebGPURenderer,
    private readonly bed: LakeBed,
    mobile: boolean,
    private readonly wind: WindModel,
  ) {
    this.resolution = mobile ? 512 : 1024
    const n = this.resolution,
      dx = LAKE_BOUNDS.size / n
    this.mask = new DataTexture(bed.water, bed.resolution, bed.resolution, RedFormat)
    this.mask.minFilter = this.mask.magFilter = NearestFilter
    this.mask.needsUpdate = true
    // RG16F is not a core WebGPU storage format. RGBA16F preserves WebGL precision.
    this.targets = [0, 1].map(() => {
      const target = new StorageTexture(n, n)
      target.type = HalfFloatType
      target.minFilter = target.magFilter = LinearFilter
      return target
    })
    this.stateNode = texture(this.targets[0]!)
    const coordinate = () => ivec2(int(instanceIndex.mod(n)), int(instanceIndex.div(n)))
    const wet = (uv: Node<'vec2'>) => texture(this.mask, uv).level(float(0)).r.greaterThanEqual(0.5)
    this.integration = this.targets.map((source, i) =>
      Fn(() => {
        const cell = coordinate(),
          uv = vec2(cell).add(0.5).div(n)
        const result = vec2(0).toVar()
        If(wet(uv), () => {
          const state = vec2(textureLoad(source, cell).r, textureLoad(source, cell).g).toVar()
          const wall = vec2(0).toVar(),
            laplacian = state.x.mul(-20).toVar()
          for (const [ox, oy] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
            [1, 1],
            [-1, -1],
            [1, -1],
            [-1, 1],
          ]) {
            const weight = ox === 0 || oy === 0 ? 4 : 1
            const adjacent = ivec2(clamp(vec2(cell).add(vec2(ox!, oy!)), vec2(0), vec2(n - 1)))
            const neighbor = state.x.toVar()
            If(wet(vec2(adjacent).add(0.5).div(n)), () => {
              neighbor.assign(textureLoad(source, adjacent).r)
            }).Else(() => {
              wall.subAssign(vec2(ox!, oy!).mul(weight / 6))
            })
            laplacian.addAssign(neighbor.mul(weight))
          }
          laplacian.divAssign(6)
          If(this.windContact.greaterThan(0).and(dot(wall, wall).greaterThan(0.001)), () => {
            const p = uv.mul(LAKE_BOUNDS.size).add(vec2(LAKE_BOUNDS.minX, LAKE_BOUNDS.minZ))
            const field = vec3(
              windField({
                p,
                footprint: float(dx),
                time: this.time,
                rotation: this.rotation,
                response: this.response,
              }) as Node<'vec3'>,
            )
            laplacian.addAssign(dot(vec2(field.y, field.z), wall).mul(dx).mul(this.windContact))
          })
          const edge = min(min(uv.x, uv.y), min(float(1).sub(uv.x), float(1).sub(uv.y)))
          const sponge = float(1).sub(smoothstep(0, 0.055, edge))
          const decay = exp(sponge.mul(16).add(WATER_DAMPING).mul(-WATER_STEP))
          const velocity = state.y
            .add(laplacian.mul((WAVE_SPEED ** 2 * WATER_STEP) / dx ** 2))
            .mul(decay)
          const height = state.x.add(velocity.mul(WATER_STEP)).mul(exp(sponge.mul(-8 * WATER_STEP)))
          result.assign(vec2(clamp(height, -0.22, 0.22), clamp(velocity, -1.5, 1.5)))
        })
        textureStore(this.targets[1 - i]!, cell, vec4(result, 0, 0)).toWriteOnly()
      })()
        .compute(n * n)
        .setName('Water fixed step'),
    )
    this.splats = this.targets.map((source, i) =>
      Fn(() => {
        const cell = coordinate(),
          uv = vec2(cell).add(0.5).div(n)
        const result = textureLoad(source, cell).rg.toVar()
        If(wet(uv), () => {
          Loop(
            { start: int(0), end: this.impulseCount, type: 'int', condition: '<' },
            ({ i: impulseIndex }) => {
              const impulse = vec4(this.impulseData.element(impulseIndex))
              const p = uv.sub(impulse.xy).div(impulse.z),
                q = dot(p, p)
              If(q.lessThan(1), () => {
                const shoulder = float(1).sub(q)
                result.y.addAssign(
                  impulse.w
                    .mul(shoulder)
                    .mul(shoulder)
                    .mul(float(1).sub(q.mul(4))),
                )
              })
            },
          )
        })
        textureStore(this.targets[1 - i]!, cell, vec4(result, 0, 0)).toWriteOnly()
      })()
        .compute(n * n)
        .setName('Water impulses'),
    )
    this.resets = this.targets.map((target) =>
      Fn(() => {
        textureStore(target, coordinate(), vec4(0)).toWriteOnly()
      })().compute(n * n),
    )
    this.reset()
  }

  get texture() {
    return this.targets[this.current]!
  }

  addImpulse(x: number, z: number, radius: number, velocity: number) {
    if (this.disposed || this.pending >= 128) return
    const cell = lakeIndex(this.bed, x, z)
    if (cell < 0 || !this.bed.water[cell]) return
    this.impulses[this.pending++]!.set(
      (x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size,
      (z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size,
      Math.max(radius, (LAKE_BOUNDS.size / this.resolution) * 2.5) / LAKE_BOUNDS.size,
      Math.max(-0.65, Math.min(0.65, velocity)),
    )
  }

  step(delta: number, windTime?: number) {
    if (this.disposed) return
    const steps = this.clock.advance(delta)
    if (!steps) return
    if (this.pending) {
      this.impulseCount.value = this.pending
      this.renderer.compute(this.splats[this.current]!)
      this.current = 1 - this.current
      this.pending = 0
    }
    for (let i = 0; i < steps; i++) {
      const time = (windTime ?? 0) - this.clock.pendingTime - (steps - i - 1) * WATER_STEP
      const wind = this.wind.sample(time)
      this.time.value = time
      this.rotation.value.fromArray(wind.rotation)
      this.response.value.fromArray(wind.response)
      this.windContact.value = windTime === undefined ? 0 : 0.8
      this.renderer.compute(this.integration[this.current]!)
      this.current = 1 - this.current
    }
    this.stateNode.value = this.texture
  }

  /** Displacement and normals consume the resident state; no WebGPU→CPU→WebGL copy. */
  createPreviewMaterial() {
    const material = new MeshStandardNodeMaterial({
      color: 0x223b48,
      roughness: 0.22,
      metalness: 0.15,
    })
    const p = positionLocal.xz,
      uv = p.sub(vec2(LAKE_BOUNDS.minX, LAKE_BOUNDS.minZ)).div(LAKE_BOUNDS.size)
    const field = vec3(
      windField({
        p,
        footprint: float(0),
        time: this.time,
        rotation: this.rotation,
        response: this.response,
      }) as Node<'vec3'>,
    )
    const dx = LAKE_BOUNDS.size / this.resolution
    material.positionNode = positionLocal.add(vec3(0, this.stateNode.sample(uv).r.add(field.x), 0))
    const gradientX = this.stateNode
      .sample(uv.add(vec2(1 / this.resolution, 0)))
      .r.sub(this.stateNode.sample(uv.sub(vec2(1 / this.resolution, 0))).r)
      .div(2 * dx)
      .add(field.y)
    const gradientZ = this.stateNode
      .sample(uv.add(vec2(0, 1 / this.resolution)))
      .r.sub(this.stateNode.sample(uv.sub(vec2(0, 1 / this.resolution))).r)
      .div(2 * dx)
      .add(field.z)
    material.normalNode = transformNormalToView(
      normalize(vec3(gradientX.negate(), 1, gradientZ.negate())),
    )
    return material
  }

  reset() {
    if (this.disposed) return
    this.clock.reset()
    this.pending = 0
    this.current = 0
    this.renderer.compute(this.resets)
    this.stateNode.value = this.texture
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const node of [...this.integration, ...this.splats, ...this.resets]) node.dispose()
    for (const target of this.targets) target.dispose()
    this.mask.dispose()
  }
}
