import { Fn, max, min, mix, texture, uniform, uv, vec2, vec4 } from 'three/tsl'
import { HalfFloatType, RenderTarget, Texture, Vector2 } from 'three/webgpu'
import type { WebGPURenderer } from 'three/webgpu'

import { FullscreenPass } from './fullscreen-pass'

/**
 * Share of the previous frame kept in each pixel. An edge that alternates between two values
 * every frame keeps (1 - h) / (1 + h) of its swing: a quarter at 0.6.
 */
const HISTORY_WEIGHT = 0.6

/**
 * A light temporal stabiliser of the view (TAA without jitter or reprojection): each frame blends
 * with the previous one, clamped to the current pixel's 3×3 neighbourhood. Crown rims, where
 * swaying cards cover and uncover sub-pixel sky, alternate within that range and settle; anything
 * that moves further than a pixel (birds, rain, a camera drift) falls outside it and keeps no
 * trail. The camera only drifts slowly, so no motion vectors are needed.
 */
export class ViewHistory {
  private readonly targets = [0, 1].map(
    () => new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false }),
  )
  private readonly current = texture(new Texture())
  private readonly previous = texture(new Texture())
  private readonly pixel = uniform(new Vector2(1, 1))
  /** Zero until a frame of the current size exists, so a fresh history never leaks in. */
  private readonly weight = uniform(0)
  private readonly pass: FullscreenPass
  private write = 0

  constructor(renderer: WebGPURenderer) {
    for (const target of this.targets) target.texture.name = 'View history'
    this.pass = new FullscreenPass(
      renderer,
      Fn(() => {
        const coord = uv()
        const at = (dx: number, dy: number) =>
          this.current.sample(coord.add(this.pixel.mul(vec2(dx, dy)))).rgb
        const centre = at(0, 0)
        const cross = [at(-1, 0), at(1, 0), at(0, -1), at(0, 1)]
        const corners = [at(-1, -1), at(1, -1), at(-1, 1), at(1, 1)]
        let low = centre,
          high = centre
        for (const tap of [...cross, ...corners]) {
          low = min(low, tap)
          high = max(high, tap)
        }
        const history = this.previous.sample(coord).rgb.clamp(low, high)
        return vec4(mix(centre, history, this.weight), 1)
      })(),
    )
  }

  resize(width: number, height: number) {
    for (const target of this.targets) target.setSize(width, height)
    this.pixel.value.set(1 / width, 1 / height)
    this.weight.value = 0
  }

  async compileAsync(source: Texture) {
    this.current.value = source
    this.previous.value = this.readTarget.texture
    await this.pass.compileAsync(this.writeTarget)
  }

  /** Blends `source` with the last frame; returns the stabilised view. */
  render(renderer: WebGPURenderer, source: Texture) {
    this.current.value = source
    this.previous.value = this.readTarget.texture
    const target = this.writeTarget
    const previous = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(target)
      this.pass.render()
    } finally {
      renderer.setRenderTarget(previous)
    }
    this.weight.value = HISTORY_WEIGHT
    this.write = 1 - this.write
    return target.texture
  }

  private get writeTarget() {
    return this.target(this.write)
  }
  private get readTarget() {
    return this.target(1 - this.write)
  }
  private target(index: number) {
    const target = this.targets[index]
    if (!target) throw new Error('View history target is unavailable')
    return target
  }

  dispose() {
    for (const target of this.targets) target.dispose()
    this.pass.dispose()
  }
}
