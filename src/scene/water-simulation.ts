import {
  AdditiveBlending,
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  RGFormat,
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

/** Match the reflecting wall to the rendered faces, rather than the expanded picking raster. */
export function createWaterMask(bed: LakeBed) {
  const resolution = Math.sqrt(bed.shore.length)
  if (resolution === bed.resolution * 2)
    return {
      resolution,
      water: Uint8Array.from(bed.shore, (distance) => (distance > 0 ? 255 : 0)),
    }
  return { resolution: bed.resolution, water: bed.water }
}

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
  readonly channels: 2 | 4
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
  private readonly splatGeometry = new InstancedBufferGeometry()
  private readonly impulses = new InstancedBufferAttribute(new Float32Array(128 * 4), 4).setUsage(
    DynamicDrawUsage,
  )
  private readonly splatMesh: Mesh
  private disposed = false
  private readonly windUniforms = createWindUniforms()

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly bed: LakeBed,
    mobile: boolean,
    private readonly wind = new WindModel(0),
  ) {
    this.resolution = mobile ? 512 : 1024
    const mask = createWaterMask(bed)
    this.mask = new DataTexture(
      mask.water,
      mask.resolution,
      mask.resolution,
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
      vertexShader: `attribute vec4 aImpulse; varying vec4 vImpulse; varying vec2 vUv;
        void main() { vUv = uv; vImpulse = aImpulse; gl_Position = vec4(aImpulse.xy * 2.0 - 1.0 + position.xy * aImpulse.z * 2.0, 0.0, 1.0); }`,
      fragmentShader: `varying vec4 vImpulse; uniform sampler2D uMask; varying vec2 vUv;
        void main() { vec2 p = (vUv - 0.5) * 2.0;
          float q = dot(p, p);
          // Compact, smooth, zero-integral pressure: the displaced center feeds
          // a surrounding shoulder instead of excavating a persistent trench.
          float profile = q < 1.0 ? (1.0-q) * (1.0-q) * (1.0-4.0*q) : 0.0;
          float wet = step(0.5, texture2D(uMask, vImpulse.xy + p * vImpulse.z).r);
          gl_FragColor = vec4(0.0, vImpulse.w * profile * wet, 0.0, 1.0); }`,
      uniforms: { uMask: { value: this.mask } },
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: AdditiveBlending,
    })
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
    let supported = renderer.extensions.has('EXT_color_buffer_float')
    this.channels = supported && this.supportsRG() ? 2 : 4
    if (supported) {
      const previous = renderer.getRenderTarget()
      try {
        for (let i = 0; i < 2; i++) {
          const target = new WebGLRenderTarget(this.resolution, this.resolution, {
            type: HalfFloatType,
            format: this.channels === 2 ? RGFormat : RGBAFormat,
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

  /** Require rendering, additive blending AND native half-float readback.
   * Some drivers render RG16F but only expose RGBA reads: keep RGBA16F there. */
  private supportsRG() {
    const renderer = this.renderer,
      gl = renderer.getContext() as WebGL2RenderingContext
    const target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGFormat,
      depthBuffer: false,
    })
    const previous = renderer.getRenderTarget(),
      face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel()
    const clear = renderer.getClearColor(new Color()),
      alpha = renderer.getClearAlpha(),
      autoClear = renderer.autoClear
    const probe = new ShaderMaterial({
      vertexShader,
      fragmentShader: 'void main() { gl_FragColor = vec4(0.125, 0.25, 0.0, 1.0); }',
      transparent: true,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    try {
      renderer.setRenderTarget(target)
      if (
        gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE ||
        gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) !== gl.RG ||
        gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) !== gl.HALF_FLOAT
      )
        return false
      renderer.autoClear = false
      renderer.setClearColor(0, 0)
      renderer.clear()
      this.quad.material = probe
      renderer.render(this.scene, this.camera)
      renderer.render(this.scene, this.camera)
      const result = new Uint16Array(2)
      renderer.readRenderTargetPixels(target, 0, 0, 1, 1, result)
      return (
        DataUtils.fromHalfFloat(result[0]!) === 0.25 && DataUtils.fromHalfFloat(result[1]!) === 0.5
      )
    } finally {
      this.quad.material = this.material
      renderer.autoClear = autoClear
      renderer.setClearColor(clear, alpha)
      renderer.setRenderTarget(previous, face, mip)
      probe.dispose()
      target.dispose()
    }
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
      if (this.pending.length) {
        for (let i = 0; i < this.pending.length; i++)
          this.pending[i]!.toArray(this.impulses.array, i * 4)
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
        this.material.uniforms.uTime!.value = time
        updateWindUniforms(this.windUniforms, this.wind.sample(time))
        this.material.uniforms.uWindContact!.value = windTime === undefined ? 0 : 1
        this.material.uniforms.uState!.value = this.texture
        const next = 1 - this.current
        this.renderer.setRenderTarget(this.targets[next]!)
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

  /** Read only on pointer movement; asynchronous fence avoids stalling the render loop. */
  async heightAt(x: number, z: number) {
    const target = this.targets[this.current]
    if (!target || this.disposed) return 0
    const px = Math.floor(((x - LAKE_BOUNDS.minX) / LAKE_BOUNDS.size) * this.resolution)
    const pz = Math.floor(((z - LAKE_BOUNDS.minZ) / LAKE_BOUNDS.size) * this.resolution)
    if (px < 0 || pz < 0 || px >= this.resolution || pz >= this.resolution) return 0
    const data = new Uint16Array(this.channels)
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
    this.splatGeometry.dispose()
    this.material.dispose()
    this.splat.dispose()
    this.pending.length = 0
  }
}
