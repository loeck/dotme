import {
  AdditiveBlending,
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector4,
  WebGLRenderTarget,
} from 'three'
import type { WebGLRenderer } from 'three'

import { LAKE_BOUNDS, lakeIndex } from './lake-bed'
import type { LakeBed } from './lake-bed'
import { WIND_FIELD_GLSL } from './water-surface'
import { WindModel, createWindUniforms, updateWindUniforms } from './wind'

export const WATER_STEP = 1 / 60
export const WAVE_SPEED = 2.4
export const WATER_DAMPING = 0.65
export const MAX_WATER_STEPS = 4

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

const vertexShader = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`
const fragmentShader = `
${WIND_FIELD_GLSL}
uniform sampler2D uState;
uniform sampler2D uMask;
uniform vec2 uTexel;
uniform float uAcceleration;
uniform float uDt;
uniform float uWindContact;
varying vec2 vUv;
vec2 wallDirection = vec2(0.0);
float neighbor(vec2 uv, float center) {
  if (texture2D(uMask, uv).r < 0.5) {
    vec2 offset = (uv - vUv) / uTexel;
    float weight = abs(offset.x) + abs(offset.y) > 1.5 ? 1.0 : 4.0;
    wallDirection -= offset * weight / 6.0;
    return center;
  }
  return texture2D(uState, uv).r;
}
void main() {
  if (texture2D(uMask, vUv).r < 0.5) { gl_FragColor = vec4(0.0); return; }
  vec2 state = texture2D(uState, vUv).rg;
  float cardinal = neighbor(vUv + vec2(uTexel.x, 0.0), state.x)
    + neighbor(vUv - vec2(uTexel.x, 0.0), state.x)
    + neighbor(vUv + vec2(0.0, uTexel.y), state.x)
    + neighbor(vUv - vec2(0.0, uTexel.y), state.x);
  float diagonal = neighbor(vUv + uTexel, state.x) + neighbor(vUv - uTexel, state.x)
    + neighbor(vUv + vec2(uTexel.x, -uTexel.y), state.x)
    + neighbor(vUv + vec2(-uTexel.x, uTexel.y), state.x);
  float laplacian = (4.0 * cardinal + diagonal - 20.0 * state.x) / 6.0;
  // Enforce the wall condition on wind + simulated height, not just on the
  // pointer waves. The incident wind slope drives a reflected disturbance.
  if (uWindContact > 0.0 && dot(wallDirection, wallDirection) > 0.001) {
    float dx = uTexel.x * ${LAKE_BOUNDS.size.toFixed(1)};
    vec2 p = vec2(${LAKE_BOUNDS.minX.toFixed(1)}, ${LAKE_BOUNDS.minZ.toFixed(1)}) + vUv * ${LAKE_BOUNDS.size.toFixed(1)};
    laplacian += dot(windField(p, dx).yz, wallDirection) * dx * uWindContact;
  }
  float edge = min(min(vUv.x, 1.0-vUv.x), min(vUv.y, 1.0-vUv.y));
  float sponge = 1.0 - smoothstep(0.0, 0.055, edge);
  float decay = exp(-(${WATER_DAMPING.toFixed(2)} + sponge * 16.0) * uDt);
  float velocity = (state.y + laplacian * uAcceleration) * decay;
  float height = (state.x + velocity * uDt) * exp(-sponge * 8.0 * uDt);
  gl_FragColor = vec4(clamp(height, -0.22, 0.22), clamp(velocity, -1.5, 1.5), 0.0, 0.0);
}
`

export class WaterSimulation {
  readonly resolution: number
  readonly available: boolean
  readonly mask: DataTexture
  private readonly zero = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat)
  private readonly targets: WebGLRenderTarget[] = []
  private current = 0
  private readonly clock = new WaterClock()
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly material: ShaderMaterial
  private readonly splat: ShaderMaterial
  private readonly quad: Mesh
  private readonly pending: Vector4[] = []
  private disposed = false
  private readonly windUniforms = createWindUniforms()

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly bed: LakeBed,
    mobile: boolean,
    private readonly wind = new WindModel(0),
  ) {
    this.resolution = mobile ? 512 : 1024
    this.mask = new DataTexture(
      bed.water,
      bed.resolution,
      bed.resolution,
      RedFormat,
      UnsignedByteType,
    )
    this.mask.minFilter = this.mask.magFilter = NearestFilter
    this.mask.needsUpdate = true
    this.zero.needsUpdate = true
    const dx = LAKE_BOUNDS.size / this.resolution
    if ((WAVE_SPEED * WATER_STEP) / dx > Math.SQRT1_2) throw new Error('Unstable water time step')
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uState: { value: this.zero },
        uMask: { value: this.mask },
        uTexel: { value: new Vector2(1 / this.resolution, 1 / this.resolution) },
        uAcceleration: { value: (WAVE_SPEED ** 2 * WATER_STEP) / dx ** 2 },
        uDt: { value: WATER_STEP },
        uTime: { value: 0 },
        ...this.windUniforms,
        uWindContact: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    })
    this.splat = new ShaderMaterial({
      vertexShader: `uniform vec4 uImpulse; varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(uImpulse.xy * 2.0 - 1.0 + position.xy * uImpulse.z * 2.0, 0.0, 1.0); }`,
      fragmentShader: `uniform vec4 uImpulse; uniform sampler2D uMask; varying vec2 vUv;
        void main() { vec2 p = (vUv - 0.5) * 2.0;
          float q = dot(p, p);
          // Compact, smooth, zero-integral pressure: the displaced center feeds
          // a surrounding shoulder instead of excavating a persistent trench.
          float profile = q < 1.0 ? (1.0-q) * (1.0-q) * (1.0-4.0*q) : 0.0;
          float wet = step(0.5, texture2D(uMask, uImpulse.xy + p * uImpulse.z).r);
          gl_FragColor = vec4(0.0, uImpulse.w * profile * wet, 0.0, 1.0); }`,
      uniforms: { uImpulse: { value: new Vector4() }, uMask: { value: this.mask } },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: AdditiveBlending,
    })
    this.quad = new Mesh(this.geometry, this.material)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)
    let supported = renderer.extensions.has('EXT_color_buffer_float')
    if (supported) {
      const previous = renderer.getRenderTarget()
      try {
        for (let i = 0; i < 2; i++) {
          const target = new WebGLRenderTarget(this.resolution, this.resolution, {
            type: HalfFloatType,
            minFilter: LinearFilter,
            magFilter: LinearFilter,
            depthBuffer: false,
            stencilBuffer: false,
          })
          this.targets.push(target)
          renderer.setRenderTarget(target)
          const gl = renderer.getContext()
          supported &&= gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
        }
      } finally {
        renderer.setRenderTarget(previous)
      }
    }
    this.available = supported
    if (!supported) {
      for (const target of this.targets) target.dispose()
      this.targets.length = 0
    }
    this.reset()
  }

  get texture() {
    return this.targets[this.current]?.texture ?? this.zero
  }

  addImpulse(x: number, z: number, radius: number, velocity: number) {
    if (!this.available || this.disposed || this.pending.length >= 128) return
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
    if (!this.available || this.disposed) return
    const steps = this.clock.advance(delta)
    if (!steps) return
    const previous = this.renderer.getRenderTarget()
    const autoClear = this.renderer.autoClear
    try {
      this.renderer.autoClear = false
      this.renderer.setRenderTarget(this.targets[this.current]!)
      this.quad.material = this.splat
      for (const impulse of this.pending) {
        this.splat.uniforms.uImpulse!.value.copy(impulse)
        this.renderer.render(this.scene, this.camera)
      }
      this.pending.length = 0
      this.quad.material = this.material
      for (let i = 0; i < steps; i++) {
        const time = (windTime ?? 0) - this.clock.pendingTime - (steps - i - 1) * WATER_STEP
        this.material.uniforms.uTime!.value = time
        updateWindUniforms(this.windUniforms, this.wind.sample(time))
        this.material.uniforms.uWindContact!.value = windTime === undefined ? 0 : 0.8
        this.material.uniforms.uState!.value = this.texture
        const next = 1 - this.current
        this.renderer.setRenderTarget(this.targets[next]!)
        this.renderer.render(this.scene, this.camera)
        this.current = next
      }
    } finally {
      this.renderer.autoClear = autoClear
      this.renderer.setRenderTarget(previous)
    }
  }

  /** Read only on pointer movement; asynchronous fence avoids stalling the render loop. */
  async heightAt(x: number, z: number) {
    const target = this.targets[this.current]
    if (!target || this.disposed) return 0
    const px = Math.floor(((x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size) * this.resolution)
    const pz = Math.floor(((z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size) * this.resolution)
    if (px < 0 || pz < 0 || px >= this.resolution || pz >= this.resolution) return 0
    const data = new Uint16Array(4)
    await this.renderer.readRenderTargetPixelsAsync(target, px, pz, 1, 1, data)
    return DataUtils.fromHalfFloat(data[0]!)
  }

  reset() {
    this.clock.reset()
    this.pending.length = 0
    const previous = this.renderer.getRenderTarget()
    const color = this.renderer.getClearColor(new Color())
    const alpha = this.renderer.getClearAlpha()
    this.renderer.setClearColor(0, 0)
    for (const target of this.targets) {
      this.renderer.setRenderTarget(target)
      this.renderer.clear()
    }
    this.renderer.setRenderTarget(previous)
    this.renderer.setClearColor(color, alpha)
  }

  dispose() {
    this.disposed = true
    for (const target of this.targets) target.dispose()
    this.mask.dispose()
    this.zero.dispose()
    this.geometry.dispose()
    this.material.dispose()
    this.splat.dispose()
    this.pending.length = 0
  }
}
