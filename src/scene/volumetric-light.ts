import {
  Fn,
  If,
  Loop,
  abs,
  clamp,
  exp,
  float,
  floor,
  getViewPosition,
  interleavedGradientNoise,
  length,
  max,
  min,
  mix,
  normalize,
  pow,
  smoothstep,
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
import { WATER_LEVEL } from './lake-bed'
import type { LightingState } from './lighting'
import { LAST_SIGNAL_LOOK, goldenHourShare } from './scene-look'
import type { SceneLook } from './scene-look'
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
/** Moonlit air scatters less than sunlit air; day shafts keep full strength. */
export function airSunScale(daylight: number) {
  return 0.35 + 0.65 * Math.max(0, Math.min(1, daylight))
}
const smooth01 = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}
/**
 * Extinction of the fine aerosol near the ground (pollen, dust, humidity) that god rays show
 * in, per metre: thin enough to keep the air clear, dense enough that the forest's shadows
 * cut visible beams through it. Golden hours thicken it, overcast skies have no beams.
 */
export function shaftDensity(sunHeight: number, daylight: number, diffuse: number) {
  const day = smooth01(0.2, 0.6, daylight)
  const golden = goldenHourShare(sunHeight)
  return 0.0013 * day * (1 + 0.25 * golden) * smooth01(0.6, 0.9, diffuse)
}
/** High sun floods the frame through the forward lobe; golden hours keep their glow. */
export function airElevationScale(directionY: number, daylight: number) {
  const dayGate = smooth01(0.3, 0.7, daylight)
  const elevationGate = 1 - smooth01(0.2, 0.6, directionY) * 0.85
  return 1 - dayGate * (1 - elevationGate)
}
/** Depth-buffer samples per pixel for the screen-space crepuscular rays. */
const RAY_SAMPLES = 20

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
  private readonly haze = uniform(LAST_SIGNAL_LOOK.base.haze)
  private readonly hazeStart = uniform(LAST_SIGNAL_LOOK.base.hazeStart)
  private readonly hazeFalloff = uniform(LAST_SIGNAL_LOOK.base.hazeFalloff)
  private readonly mist = uniform(LAST_SIGNAL_LOOK.base.mist)
  private readonly mistTop = uniform(LAST_SIGNAL_LOOK.base.mistTop)
  private readonly shadowBias = uniform(0)
  private readonly hasTerrain = uniform(false)
  private readonly airSize = uniform(new Vector2(1, 1))
  private readonly viewProjection = uniform(new Matrix4())
  private readonly shafts = uniform(0)
  private readonly sunGlow = uniform(new Color())
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
        // Samples crowd toward the eye (quadratic spacing) where beams between the trees are a
        // metre or two across, and each pixel starts at its own offset: the composite's
        // depth-aware filter turns the jitter into smooth beams instead of step bands.
        const span = max(0, distance.sub(entry)),
          jitter = interleavedGradientNoise(uv().mul(this.airSize).floor()),
          accumulated = float(1).toVar(),
          radiance = vec3(0).toVar()
        const phase = airPhase(ray.dot(this.sunDirection)),
          ambient = this.ambient.rgb.add(sky.horizon(ray).mul(this.skyAir))
        If(span.greaterThan(0).and(sigma.greaterThan(0)), () => {
          Loop(steps, ({ i }) => {
            const t0 = float(i).div(steps),
              t1 = float(i).add(1).div(steps),
              tj = float(i).add(jitter).div(steps)
            const along = entry.add(span.mul(tj.mul(tj)))
            const segment = span.mul(t1.mul(t1).sub(t0.mul(t0)))
            const world = this.eye.add(ray.mul(along))
            // Height fog that thins upward and only starts past the foreground, plus a
            // low mist layer resting on the water: Last Signal separates depth with air.
            const height = max(world.y.sub(WATER_LEVEL), 0)
            const stepExtinction = sigma
              .mul(this.haze)
              .mul(exp(this.hazeFalloff.mul(height).negate()))
              .mul(smoothstep(this.hazeStart.mul(0.35), this.hazeStart, along))
              .add(
                this.mist.mul(smoothstep(this.mistTop.mul(0.35), this.mistTop, height).oneMinus()),
              )
            // The beam aerosol hugs the ground and the water, from a couple of metres out.
            const aerosol = this.shafts.mul(exp(height.mul(-0.07))).mul(smoothstep(0.5, 3, along))
            const totalExtinction = stepExtinction.add(aerosol)
            const transmission = exp(totalExtinction.mul(segment).negate()),
              integral = segmentIntegral(totalExtinction, segment)
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
            // The aerosol scatters the sun into beams but adds little sky light: it must not
            // grey the air.
            const source = ambient
              .mul(stepExtinction.add(aerosol.mul(0.2)))
              .add(this.sunRadiance.rgb.mul(visible).mul(phase).mul(2).mul(totalExtinction))
            radiance.addAssign(accumulated.mul(source).mul(integral))
            accumulated.mulAssign(transmission)
          })
        })
        // Crepuscular rays in screen space: when the sun is in or near the frame, march from
        // this pixel toward its disc through the depth buffer, and let the open sky between
        // the crowns and ridges stream light along the way. It catches beams through canopy
        // gaps finer than the shadow map resolves.
        const sunClip = this.viewProjection.mul(vec4(this.eye.add(this.sunDirection.mul(1000)), 1))
        const sunUv = vec2(sunClip.x, sunClip.y.negate())
          .div(max(sunClip.w, 0.0001))
          .mul(0.5)
          .add(0.5)
        const facing = smoothstep(0.0, 0.25, sunClip.w.div(1000))
        const offscreen = max(abs(sunUv.x.sub(0.5)), abs(sunUv.y.sub(0.5)))
        const inFrame = smoothstep(1.1, 0.55, offscreen).mul(facing)
        // `sunGlow` is zero at night, when the light direction is the moon's.
        If(inFrame.greaterThan(0.001).and(this.sunGlow.r.greaterThan(0)), () => {
          const lit = float(0).toVar(),
            weights = float(0).toVar()
          Loop(RAY_SAMPLES, ({ i }) => {
            const t = float(i).add(jitter).div(RAY_SAMPLES)
            const coord = mix(uv(), sunUv, t)
            const inside = coord
              .greaterThanEqual(vec2(0))
              .all()
              .and(coord.lessThanEqual(vec2(1)).all())
            const clear = inside.select(
              smoothstep(0.99995, 1, this.depth.sample(clamp(coord, 0, 1)).r),
              1,
            )
            // Nearer occluders weigh more: a beam is born at the gap it passes.
            const weight = float(1).sub(t.mul(0.6))
            lit.addAssign(clear.mul(weight))
            weights.addAssign(weight)
          })
          // A tight forward lobe (half strength about 9° from the disc) plus a faint wide one:
          // beams fan from the sun without veiling the whole frame.
          const toward = max(ray.dot(this.sunDirection), 0)
          const glow = pow(toward, 60).add(pow(toward, 6).mul(0.05))
          // Beams live where the line to the sun is partly blocked, between branches and at
          // ridge edges; fully open sky already carries the sun's own glow, so it takes little.
          const open = lit.div(weights)
          const beams = open.mul(0.25).add(open.mul(open.oneMinus()).mul(4 * 0.75))
          // In-scattered light grows with the air in front of the pixel, up to ~120 m; the sky
          // itself takes a third.
          const air = smoothstep(2, 120, length(delta)).mul(
            smoothstep(0.99995, 1, depth).mul(-0.67).add(1),
          )
          radiance.addAssign(this.sunGlow.rgb.mul(beams).mul(glow).mul(air).mul(inFrame))
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
        // A depth-aware 3 × 3 tent over the half-resolution air: it smooths the raymarch's
        // per-pixel jitter into continuous beams without bleeding air across silhouettes.
        const center = distanceAt(uv()),
          pixel = uv().mul(this.airSize).sub(0.5),
          base = floor(pixel.add(0.5)),
          f = pixel.sub(base)
        const sum = vec4(0).toVar(),
          total = float(0).toVar(),
          nearest = vec4(0, 0, 0, 1).toVar(),
          nearestDifference = float(1e10).toVar()
        for (let y = -1; y <= 1; y++)
          for (let x = -1; x <= 1; x++) {
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
            const tent = max(vec2(0), vec2(1.5).sub(abs(offset.sub(f))))
            const weight = tent.x
              .mul(tent.y)
              .mul(exp(difference.negate().div(max(0.25, center.mul(0.015)))))
            sum.addAssign(decoded.mul(weight))
            total.addAssign(weight)
          }
        const air = total.greaterThan(0.00001).select(sum.div(max(total, 0.00001)), nearest)
        return vec4(this.source.sample(uv()).rgb.mul(air.a).add(air.rgb), 1)
      })(),
    )
  }
  update(light: LightingState, look: SceneLook) {
    this.sunDirection.value.copy(light.direction)
    const golden = goldenHourShare(light.sunDirection.y)
    this.shafts.value = shaftDensity(light.sunDirection.y, light.daylight, light.weatherDiffuse)
    // Screen-space rays: day sun only, strongest low in the sky, gone under cloud cover.
    this.sunGlow.value
      .copy(light.color)
      .multiplyScalar(
        light.sunDirection.y > 0
          ? light.intensity *
              0.06 *
              (0.35 + 0.65 * golden) *
              smooth01(0.6, 0.9, light.weatherDiffuse) *
              look.sunScattering
          : 0,
      )
    this.sunRadiance.value
      .copy(light.color)
      .multiplyScalar(
        light.intensity *
          airSunScale(light.daylight) *
          airElevationScale(light.direction.y, light.daylight) *
          look.sunScattering,
      )
    this.haze.value = look.haze
    this.hazeStart.value = look.hazeStart
    this.hazeFalloff.value = look.hazeFalloff
    this.mist.value = look.mist
    this.mistTop.value = look.mistTop
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
    this.viewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
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
