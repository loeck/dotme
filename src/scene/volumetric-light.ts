import {
  Fn,
  If,
  Loop,
  abs,
  clamp,
  exp,
  float,
  floor,
  fract,
  getViewPosition,
  length,
  max,
  min,
  mix,
  normalize,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  DepthTexture,
  HalfFloatType,
  Matrix4,
  NearestFilter,
  RenderTarget,
  Vector2,
  Vector3,
} from 'three/webgpu'
import type { DirectionalLight, Node, PerspectiveCamera, WebGPURenderer } from 'three/webgpu'

import { celestialVisibility, cloudShadow } from './cloud-shadows'
import type { CloudShadowUniforms } from './cloud-shadows'
import { FullscreenPass } from './fullscreen-pass'
import type { LightingState } from './lighting'
import type { SkyAtmosphere } from './sky-atmosphere'

export function segmentIntegral(extinction: Node<'float'>, distance: Node<'float'>) {
  const tau = extinction.mul(distance)
  return tau
    .lessThan(0.001)
    .select(
      distance.mul(float(1).sub(tau.mul(0.5)).add(tau.mul(tau).div(6))),
      exp(tau.negate()).oneMinus().div(max(extinction, 0.0000001)),
    )
}
export function airPhase(cosine: Node<'float'>) {
  return float(0.0795774715 * 0.64).div(float(1.36).sub(cosine.mul(1.2)).pow(1.5))
}
export class VolumetricLight {
  readonly target = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false })
  readonly airTarget = new RenderTarget(1, 1, {
    type: HalfFloatType,
    depthBuffer: false,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
  })
  private readonly fallbackDepth = new DepthTexture(1, 1)
  private readonly depth = texture(this.fallbackDepth)
  private readonly terrain = texture<'float'>(this.fallbackDepth)
  private readonly source = texture(this.target.texture)
  private readonly air = texture(this.airTarget.texture)
  private readonly inverseProjection = uniform(new Matrix4())
  private readonly cameraWorld = uniform(new Matrix4())
  private readonly shadowMatrix = uniform(new Matrix4())
  private readonly eye = uniform(new Vector3())
  private readonly sunDirection = uniform(new Vector3())
  private readonly sunRadiance = uniform(new Color())
  private readonly ambient = uniform(new Color())
  private readonly skyAir = uniform(0)
  private readonly shadowBias = uniform(0)
  private readonly hasTerrain = uniform(false)
  private readonly airSize = uniform(new Vector2(1, 1))
  private readonly cameraRange = uniform(new Vector2(0.05, 500))
  private readonly airDivisor: number
  private readonly scatter: FullscreenPass
  private readonly composite: FullscreenPass
  constructor(
    renderer: WebGPURenderer,
    sky: SkyAtmosphere,
    lowPower: boolean,
    clouds: CloudShadowUniforms,
    extinction: number,
    steps = lowPower ? 16 : 32,
  ) {
    this.airDivisor = lowPower ? 3 : 2
    this.target.texture.name = 'Atmosphere composite'
    this.airTarget.texture.name = 'Air radiance / transmission'
    const sigma = float(extinction)
    this.scatter = new FullscreenPass(
      renderer,
      Fn(() => {
        const depth = this.depth.sample(uv()).r
        const view = getViewPosition(uv(), depth, this.inverseProjection)
        const endpoint = this.cameraWorld.mul(vec4(view, 1)).xyz
        const delta = endpoint.sub(this.eye),
          distance = min(length(delta), 240).toVar(),
          ray = normalize(delta),
          entry = float(0).toVar()
        If(abs(ray.y).greaterThan(0.00001), () => {
          const a = float(-20).sub(this.eye.y).div(ray.y),
            b = float(80).sub(this.eye.y).div(ray.y)
          entry.assign(max(0, min(a, b)))
          distance.assign(min(distance, max(a, b)))
        }).ElseIf(this.eye.y.lessThan(-20).or(this.eye.y.greaterThan(80)), () => {
          distance.assign(0)
        })
        const stride = max(0, distance.sub(entry)).div(steps),
          accumulated = float(1).toVar(),
          radiance = vec3(0).toVar()
        const transmission = exp(sigma.mul(stride).negate()),
          integral = segmentIntegral(sigma, stride),
          phase = airPhase(ray.dot(this.sunDirection)),
          ambient = this.ambient.rgb.add(sky.horizon(ray).mul(this.skyAir))
        If(stride.greaterThan(0).and(sigma.greaterThan(0)), () => {
          Loop(steps, ({ i }) => {
            const world = this.eye.add(ray.mul(entry.add(float(i).add(0.5).mul(stride))))
            const visible = float(0).toVar()
            If(this.sunDirection.y.greaterThan(0), () => {
              const projected = this.shadowMatrix.mul(vec4(world, 1)),
                p = projected.xyz.div(projected.w)
              visible.assign(1)
              If(
                this.hasTerrain
                  .and(p.greaterThanEqual(vec3(0)).all())
                  .and(p.lessThanEqual(vec3(1)).all()),
                () => {
                  // LightShadow.matrix produces bottom-left UVs; WebGPU depth
                  // textures use top-left UVs, matching ShadowNode's conversion.
                  visible.assign(
                    this.terrain.sample(p.xy.flipY()).compare(p.z.add(this.shadowBias)),
                  )
                },
              )
              visible.mulAssign(celestialVisibility(clouds))
              visible.mulAssign(cloudShadow(world, clouds))
            })
            const source = ambient
              .add(this.sunRadiance.rgb.mul(visible).mul(phase).mul(6))
              .mul(sigma)
            radiance.addAssign(accumulated.mul(source).mul(integral))
            accumulated.mulAssign(transmission)
          })
        })
        return vec4(sqrt(max(radiance, vec3(0)).div(16)), accumulated)
      })(),
    )
    this.composite = new FullscreenPass(
      renderer,
      Fn(() => {
        const distanceAt = (coord: Node<'vec2'>) =>
          this.cameraRange.x
            .mul(this.cameraRange.y)
            .div(
              this.cameraRange.y.sub(
                this.depth.sample(coord).r.mul(this.cameraRange.y.sub(this.cameraRange.x)),
              ),
            )
        const center = distanceAt(uv()),
          pixel = uv().mul(this.airSize).sub(0.5),
          base = floor(pixel),
          f = fract(pixel)
        const sum = vec4(0).toVar(),
          total = float(0).toVar(),
          nearest = vec4(0, 0, 0, 1).toVar(),
          nearestDifference = float(1e10).toVar()
        for (let y = 0; y < 2; y++)
          for (let x = 0; x < 2; x++) {
            const offset = vec2(x, y),
              coord = clamp(
                base.add(offset).add(0.5).div(this.airSize),
                vec2(0.5).div(this.airSize),
                vec2(1).sub(vec2(0.5).div(this.airSize)),
              )
            const difference = abs(distanceAt(coord).sub(center)),
              value = this.air.sample(coord),
              decoded = vec4(value.rgb.mul(value.rgb).mul(16), value.a)
            If(difference.lessThan(nearestDifference), () => {
              nearest.assign(decoded)
              nearestDifference.assign(difference)
            })
            const bilinear = mix(f.oneMinus(), f, offset),
              weight = bilinear.x
                .mul(bilinear.y)
                .mul(exp(difference.negate().div(max(0.25, center.mul(0.015)))))
            sum.addAssign(decoded.mul(weight))
            total.addAssign(weight)
          }
        const air = total.greaterThan(0.00001).select(sum.div(max(total, 0.00001)), nearest)
        return vec4(this.source.sample(uv()).rgb.mul(air.a).add(air.rgb), 1)
      })(),
    )
  }
  update(light: LightingState) {
    this.sunDirection.value.copy(light.sunDirection)
    this.sunRadiance.value.copy(light.sunColor).multiplyScalar(light.sunIntensity)
    const airDay = 1 - light.daylight * 0.7
    this.ambient.value.copy(light.nightHaze).multiplyScalar(airDay)
    this.skyAir.value = 0.5 * airDay
  }
  resize(width: number, height: number) {
    this.target.setSize(width, height)
    this.airTarget.setSize(
      Math.max(1, Math.ceil(width / this.airDivisor)),
      Math.max(1, Math.ceil(height / this.airDivisor)),
    )
    this.airSize.value.set(this.airTarget.width, this.airTarget.height)
  }
  private prepare(input: RenderTarget, camera: PerspectiveCamera, light: DirectionalLight) {
    const depth = input.depthTexture
    if (!depth) return false
    this.depth.value = depth
    this.source.value = input.texture
    const shadow = light.shadow.map?.depthTexture
    this.hasTerrain.value = !!shadow
    if (shadow) this.terrain.value = shadow
    this.shadowMatrix.value.copy(light.shadow.matrix)
    this.shadowBias.value = light.shadow.bias
    this.inverseProjection.value.copy(camera.projectionMatrixInverse)
    this.cameraWorld.value.copy(camera.matrixWorld)
    this.eye.value.copy(camera.position)
    this.cameraRange.value.set(camera.near, camera.far)
    return true
  }
  async compileAsync(input: RenderTarget, camera: PerspectiveCamera, light: DirectionalLight) {
    if (!this.prepare(input, camera, light)) return
    await this.scatter.compileAsync(this.airTarget)
    await this.composite.compileAsync(this.target)
  }
  render(
    renderer: WebGPURenderer,
    input: RenderTarget,
    camera: PerspectiveCamera,
    light: DirectionalLight,
  ) {
    if (!this.prepare(input, camera, light)) return input.texture
    const previous = renderer.getRenderTarget()
    try {
      renderer.setRenderTarget(this.airTarget)
      this.scatter.render()
      renderer.setRenderTarget(this.target)
      this.composite.render()
    } finally {
      renderer.setRenderTarget(previous)
    }
    return this.target.texture
  }
  dispose() {
    this.target.dispose()
    this.airTarget.dispose()
    this.fallbackDepth.dispose()
    this.scatter.dispose()
    this.composite.dispose()
  }
}
