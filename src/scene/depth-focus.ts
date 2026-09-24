import {
  Fn,
  If,
  Loop,
  clamp,
  cos,
  float,
  max,
  mix,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl'
import { DepthTexture, HalfFloatType, RenderTarget, UnsignedIntType, Vector2 } from 'three/webgpu'
import type { DirectionalLight, Node, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'

import { FullscreenPass } from './fullscreen-pass'
import type { RenderDiagnostics } from './render-diagnostics'
import type { VolumetricLight } from './volumetric-light'

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
  private readonly cameraRange = uniform(new Vector2(0.05, 500))
  constructor(renderer: WebGPURenderer, mobile: boolean) {
    this.target.texture.name = 'Landscape lens color'
    const samples = mobile ? 12 : 20
    const distance = (coord: Node<'vec2'>) => {
      const d = this.depth.sample(coord).r
      return this.cameraRange.x
        .mul(this.cameraRange.y)
        .div(this.cameraRange.y.sub(d.mul(this.cameraRange.y.sub(this.cameraRange.x))))
    }
    this.pipeline = new FullscreenPass(
      renderer,
      Fn(() => {
        const centerDistance = distance(uv())
        const radius = max(
          smoothstep(5, 21, centerDistance).oneMinus().mul(1.25),
          smoothstep(90, 180, centerDistance).mul(1.35),
        )
        const color = this.color.sample(uv()).rgb.toVar(),
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
        return vec4(color, 1)
      })(),
      true,
    )
  }
  resize(bufferWidth: number, bufferHeight: number, cssWidth: number, cssHeight: number) {
    this.target.setSize(bufferWidth, bufferHeight)
    this.cssPixel.value.set(1 / cssWidth, 1 / cssHeight)
  }
  get depthTexture() {
    const depth = this.target.depthTexture
    if (!depth) throw new Error('Landscape depth texture is unavailable')
    return depth
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
    diagnostics?: RenderDiagnostics,
  ) {
    this.cameraRange.value.set(camera.near, camera.far)
    const previous = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(this.target)
      if (diagnostics) diagnostics.measure('main', () => renderer.render(scene, camera))
      else renderer.render(scene, camera)
      this.color.value =
        atmosphere && light
          ? atmosphere.render(renderer, this.target, camera, light)
          : this.target.texture
      renderer.setRenderTarget(previous)
      if (diagnostics) diagnostics.measure('depth-focus', () => this.pipeline.render())
      else this.pipeline.render()
    } finally {
      renderer.setRenderTarget(previous)
    }
  }
  dispose() {
    this.target.dispose()
    this.pipeline.dispose()
  }
}
