import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js'
import type BloomNode from 'three/examples/jsm/tsl/display/BloomNode.js'
import {
  Fn,
  If,
  Loop,
  abs,
  clamp,
  cos,
  dot,
  float,
  max,
  min,
  mix,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { DepthTexture, HalfFloatType, RenderTarget, UnsignedIntType, Vector2 } from 'three/webgpu'
import type {
  DirectionalLight,
  Node,
  PerspectiveCamera,
  Scene,
  UniformNode,
  WebGPURenderer,
} from 'three/webgpu'

import { SceneRenderDiagnostics } from './diagnostics'
import { FullscreenPass } from './fullscreen-pass'
import { lensFlare } from './lens-flare'
import type { SceneGrade } from './scene-grade'
import type { VolumetricLight } from './volumetric-light'

/** A surface whose planar reflection renders as its own pass ahead of the view. */
export type PlanarMirror = Readonly<{
  renderReflection: (renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera) => void
}>

/** Texture name of the main view's render target, which GPU captures attribute by. */
export const LENS_TARGET = 'Landscape lens color'

const REC709 = vec3(0.2126, 0.7152, 0.0722)

/**
 * Bloom reads the graded radiance, so its threshold is in exposed units: ACES maps 1 to
 * about 0.8 on screen, and only the sun, its glitter, lamps and fireflies pass it. The knee
 * fades the threshold in over half its value instead of cutting it (a fixed knee would let
 * the whole night frame into a low threshold and veil it), and the ceiling keeps the sun's
 * half-float disc from washing the frame in a uniform glow.
 */
const BLOOM = { knee: 0.5, ceiling: 24, radius: 0.55 }

/** Soft-knee bright pass (Karis): a quadratic ramp below the threshold, linear above it. */
function brightPass(params: {
  input: Node<'vec4'>
  threshold: UniformNode<'float'>
  smoothWidth: UniformNode<'float'>
}) {
  const colour = min(params.input.rgb, vec3(BLOOM.ceiling))
  const brightness = max(colour.r, max(colour.g, colour.b))
  const knee = params.threshold.mul(params.smoothWidth)
  const soft = clamp(brightness.sub(params.threshold).add(knee), 0, knee.mul(2))
  const ramp = soft.mul(soft).div(knee.mul(4).add(0.00001))
  const share = max(ramp, brightness.sub(params.threshold)).div(max(brightness, 0.00001))
  return vec4(colour.mul(share), 1)
}

/** Scene radiance and depth remain linear until the final output transform. */
export class DepthFocus {
  readonly target = new RenderTarget(1, 1, {
    type: HalfFloatType,
    depthTexture: new DepthTexture(1, 1, UnsignedIntType),
    stencilBuffer: false,
  })
  private readonly pipeline: FullscreenPass
  private readonly color = texture(this.target.texture)
  private readonly depth = texture(this.depthTexture)
  private readonly cssPixel = uniform(new Vector2(1, 1))
  private readonly bufferPixel = uniform(new Vector2(1, 1))
  private readonly cameraRange = uniform(new Vector2(0.05, 500))
  private readonly glow: BloomNode
  /** The sun's position on the frame (UV) and how strongly it may flare the lens. */
  private readonly flareSun = uniform(new Vector2(0.5, 0.5))
  private readonly flare = uniform(0)
  constructor(renderer: WebGPURenderer, lowPower: boolean, grade: SceneGrade) {
    this.target.texture.name = LENS_TARGET
    const samples = lowPower ? 12 : 20
    const distance = (coord: Node<'vec2'>) => {
      const d = this.depth.sample(coord).r
      return this.cameraRange.x
        .mul(this.cameraRange.y)
        .div(this.cameraRange.y.sub(d.mul(this.cameraRange.y.sub(this.cameraRange.x))))
    }
    /**
     * Edge antialiasing (FXAA, Lottes's console variant) on the linear radiance: luma is
     * compressed as display would be, then the pixel blends along the edge it straddles. The
     * scene draws without MSAA, so alpha-tested leaves, grass blades and twigs otherwise step.
     */
    const antialiased = (coord: Node<'vec2'>) => {
      const px = this.bufferPixel
      const at = (dx: number, dy: number) => this.color.sample(coord.add(px.mul(vec2(dx, dy)))).rgb
      const luma = (c: Node<'vec3'>) => {
        const l = dot(c, REC709)
        return sqrt(l.div(l.add(1)))
      }
      const centre = this.color.sample(coord).rgb
      const lM = luma(centre)
      const lNW = luma(at(-1, -1)),
        lNE = luma(at(1, -1)),
        lSW = luma(at(-1, 1)),
        lSE = luma(at(1, 1))
      const lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)))
      const lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)))
      const dir = vec2(lSW.add(lSE).sub(lNW.add(lNE)), lNW.add(lSW).sub(lNE.add(lSE))).toVar()
      const reduce = max(
        lNW
          .add(lNE)
          .add(lSW)
          .add(lSE)
          .mul(0.25 * 0.125),
        1 / 128,
      )
      const scale = float(1).div(min(abs(dir.x), abs(dir.y)).add(reduce))
      const step = clamp(dir.mul(scale), -8, 8).mul(px)
      const sampleAt = (k: number) => this.color.sample(coord.add(step.mul(k))).rgb
      const a = sampleAt(1 / 3 - 0.5)
        .add(sampleAt(2 / 3 - 0.5))
        .mul(0.5)
      const b = a.mul(0.5).add(sampleAt(-0.5).add(sampleAt(0.5)).mul(0.25))
      const lB = luma(b)
      const blended = select(lB.lessThan(lMin).or(lB.greaterThan(lMax)), a, b)
      // Flat regions keep the untouched pixel: no blur where there is no edge.
      return select(lMax.sub(lMin).lessThan(max(0.04, lMax.mul(0.125))), centre, blended)
    }
    // Graded before the bright pass so the threshold follows exposure through the day and night.
    this.glow = bloom(
      vec4(grade.colour(this.color.rgb), 1),
      grade.glow,
      BLOOM.radius,
      grade.glowThreshold,
    )
    this.glow.smoothWidth.value = BLOOM.knee
    this.glow.highPassFn = brightPass
    // The blur is wide and soft: a reduced chain costs a fraction of the full-resolution one.
    this.glow.setResolutionScale(lowPower ? 0.25 : 0.5)
    this.pipeline = new FullscreenPass(
      renderer,
      Fn(() => {
        const centerDistance = distance(uv())
        // A lens focused tens of metres out at a moderate aperture keeps the bank a few metres
        // away nearly sharp: a stronger near blur smeared fine grass blades into fur.
        const radius = max(
          smoothstep(4, 14, centerDistance).oneMinus().mul(0.6),
          smoothstep(90, 180, centerDistance).mul(1.35),
        )
        const color = antialiased(uv()).toVar(),
          weight = float(1).toVar()
        If(radius.greaterThan(0.3), () => {
          Loop(samples, ({ i }) => {
            const index = float(i).add(0.5),
              angle = index.mul(2.39996323),
              ring = sqrt(index.div(samples))
            const point = clamp(
              uv().add(vec2(cos(angle), sin(angle)).mul(ring).mul(radius).mul(this.cssPixel)),
              0,
              1,
            )
            const sampleDistance = distance(point)
            const foreground = smoothstep(14, 21, centerDistance).oneMinus()
            const accepted = mix(
              smoothstep(centerDistance.mul(0.65), centerDistance.mul(0.9), sampleDistance),
              1,
              foreground,
            )
            color.addAssign(this.color.sample(point).rgb.mul(accepted))
            weight.addAssign(accepted)
          })
          color.divAssign(weight)
        })
        const aspect = this.cssPixel.y.div(this.cssPixel.x)
        const flare = lensFlare(uv(), this.flareSun, this.flare, aspect)
        return vec4(grade.colour(color).add(this.glow.rgb).add(flare).mul(grade.frameEdge(uv())), 1)
      })(),
      true,
      (display) => grade.finish(display),
    )
  }
  resize(bufferWidth: number, bufferHeight: number, cssWidth: number, cssHeight: number) {
    this.target.setSize(bufferWidth, bufferHeight)
    this.bufferPixel.value.set(1 / bufferWidth, 1 / bufferHeight)
    this.cssPixel.value.set(1 / cssWidth, 1 / cssHeight)
  }
  /** Places the sun for the flare: `uv` on the frame (y up), `strength` from `flareStrength`. */
  setFlare(x: number, y: number, strength: number) {
    this.flareSun.value.set(x, y)
    this.flare.value = Number.isFinite(strength) ? Math.max(0, strength) : 0
  }

  get depthTexture() {
    const depth = this.target.depthTexture
    if (!depth) throw new Error('Landscape depth texture is unavailable')
    return depth
  }
  /**
   * Draws the lens once offscreen. The bloom's blur chain builds its own materials only when
   * it first runs, which would otherwise stall the first presented frame.
   */
  warmup(renderer: WebGPURenderer) {
    const previous = renderer.getRenderTarget()
    const scratch = new RenderTarget(1, 1, { depthBuffer: false })
    try {
      renderer.setRenderTarget(scratch)
      this.pipeline.render()
    } finally {
      renderer.setRenderTarget(previous)
      scratch.dispose()
    }
  }
  async compileAsync(renderer: WebGPURenderer, camera: PerspectiveCamera) {
    this.cameraRange.value.set(camera.near, camera.far)
    await this.pipeline.compileAsync(renderer.getRenderTarget())
  }
  render(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    atmosphere?: VolumetricLight,
    light?: DirectionalLight,
    mirror?: PlanarMirror,
  ) {
    this.cameraRange.value.set(camera.near, camera.far)
    const previous = renderer.getRenderTarget()
    try {
      const info = renderer.info.render
      const view = SceneRenderDiagnostics.beginActive('view', info.calls)
      mirror?.renderReflection(renderer, scene, camera)
      renderer.setRenderTarget(this.target)
      renderer.render(scene, camera)
      SceneRenderDiagnostics.endActive(view, info.calls)
      const air = SceneRenderDiagnostics.beginActive('atmosphere', info.calls)
      this.color.value =
        atmosphere && light
          ? atmosphere.render(renderer, this.target, camera, light)
          : this.target.texture
      SceneRenderDiagnostics.endActive(air, info.calls)
      const lens = SceneRenderDiagnostics.beginActive('lens', info.calls)
      renderer.setRenderTarget(previous)
      this.pipeline.render()
      SceneRenderDiagnostics.endActive(lens, info.calls)
    } finally {
      renderer.setRenderTarget(previous)
    }
  }
  dispose() {
    this.glow.dispose()
    this.target.dispose()
    this.pipeline.dispose()
  }
}
