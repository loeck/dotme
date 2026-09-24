import {
  Fn,
  If,
  Loop,
  abs,
  acos,
  clamp,
  cos,
  exp,
  float,
  length,
  max,
  sin,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { HalfFloatType, LinearFilter, RenderTarget, Vector3 } from 'three/webgpu'
import type { Node, TextureNode } from 'three/webgpu'

import { EARTH } from './atmosphere-physics'
import { FullscreenPass } from './fullscreen-pass'
import type { FullscreenRenderer } from './fullscreen-pass'

const Rg = EARTH.groundRadius,
  Rt = EARTH.topRadius,
  TOP_HORIZON = Math.sqrt(Rt * Rt - Rg * Rg),
  VIEW_RADIUS = Rg + EARTH.viewerHeight,
  BETA = Math.acos(Math.sqrt(VIEW_RADIUS * VIEW_RADIUS - Rg * Rg) / VIEW_RADIUS),
  ZENITH_HORIZON = Math.PI - BETA
const TRANSMITTANCE_SIZE = [256, 64] as const,
  MULTIPLE_SIZE = 32

const lutTarget = (width: number, height: number, name: string) => {
  const target = new RenderTarget(width, height, {
    type: HalfFloatType,
    depthBuffer: false,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
  })
  target.texture.name = name
  return target
}
// Hillaire's texel-centre remapping keeps the LUT edges exact.
const toSubUv = (unit: Node<'vec2'>, size: Node<'vec2'>) =>
  unit.add(vec2(0.5).div(size)).mul(size.div(size.add(1)))
const fromSubUv = (coord: Node<'vec2'>, size: Node<'vec2'>) =>
  coord.sub(vec2(0.5).div(size)).mul(size.div(size.sub(1)))

// (r - R)(r + R) avoids cancelling two ~4e7 squares in single precision.
const discriminant = (radius: Node<'float'>, mu: Node<'float'>, sphere: number) =>
  radius
    .mul(radius)
    .mul(mu)
    .mul(mu)
    .sub(radius.sub(sphere).mul(radius.add(sphere)))

function transmittanceUv(radius: Node<'float'>, mu: Node<'float'>) {
  const rho = sqrt(max(radius.sub(Rg).mul(radius.add(Rg)), 0)),
    distance = max(
      0,
      radius
        .mul(mu)
        .negate()
        .add(sqrt(max(discriminant(radius, mu, Rt), 0))),
    ),
    near = float(Rt).sub(radius),
    far = rho.add(TOP_HORIZON)
  return vec2(distance.sub(near).div(max(far.sub(near), 1e-6)), rho.div(TOP_HORIZON))
}
const hitsGround = (radius: Node<'float'>, mu: Node<'float'>) =>
  mu.lessThan(0).and(discriminant(radius, mu, Rg).greaterThanEqual(0))

function medium(height: Node<'float'>) {
  const rayleigh = vec3(...EARTH.rayleighScattering).mul(exp(height.div(-EARTH.rayleighHeight))),
    aerosol = exp(height.div(-EARTH.mieHeight)),
    ozone = max(0, float(1).sub(abs(height.sub(EARTH.ozoneCenter)).div(EARTH.ozoneHalfWidth)))
  return {
    rayleigh,
    mie: aerosol.mul(EARTH.mieScattering),
    extinction: rayleigh
      .add(aerosol.mul(EARTH.mieExtinction))
      .add(vec3(...EARTH.ozoneAbsorption).mul(ozone)),
  }
}
const rayleighPhase = (cosine: Node<'float'>) =>
  cosine
    .mul(cosine)
    .add(1)
    .mul(3 / (16 * Math.PI))
function miePhase(cosine: Node<'float'>) {
  const g = EARTH.mieAnisotropy
  return cosine
    .mul(cosine)
    .add(1)
    .mul((3 / (8 * Math.PI)) * ((1 - g * g) / (2 + g * g)))
    .div(
      float(1 + g * g)
        .sub(cosine.mul(2 * g))
        .pow(1.5),
    )
}

type Luts = { transmittance: TextureNode; multiple?: TextureNode }
type March = {
  radius: Node<'float'>
  ray: Node<'vec3'>
  sun: Node<'vec3'>
  steps: number
  luts: Luts
  isotropic?: boolean
  ground?: boolean
}
/** Single scattering plus Hillaire's multiple-scattering term along one view ray. */
function integrate({ radius, ray, sun, steps, luts, isotropic = false, ground = false }: March) {
  const mu = ray.y,
    groundHit = hitsGround(radius, mu),
    distance = max(
      groundHit.select(
        radius
          .mul(mu)
          .negate()
          .sub(sqrt(max(discriminant(radius, mu, Rg), 0))),
        radius
          .mul(mu)
          .negate()
          .add(sqrt(max(discriminant(radius, mu, Rt), 0))),
      ),
      0,
    ),
    dt = distance.div(steps),
    cosine = ray.dot(sun)
  const phaseR = isotropic ? float(1 / (4 * Math.PI)) : rayleighPhase(cosine),
    phaseM = isotropic ? float(1 / (4 * Math.PI)) : miePhase(cosine)
  const light = vec3(0).toVar(),
    transfer = vec3(0).toVar(),
    throughput = vec3(1).toVar()
  const sunlight = (r: Node<'float'>, muS: Node<'float'>) =>
    hitsGround(r, muS).select(
      vec3(0),
      luts.transmittance.sample(transmittanceUv(r, muS)).level(float(0)).rgb,
    )
  Loop(steps, ({ i }) => {
    const p = vec3(0, radius, 0).add(ray.mul(float(i).add(0.3).mul(dt))),
      r = length(p),
      height = r.sub(Rg),
      muS = p.dot(sun).div(r)
    const air = medium(height),
      scattering = air.rayleigh.add(air.mie)
    let source = sunlight(r, muS).mul(air.rayleigh.mul(phaseR).add(air.mie.mul(phaseM)))
    if (luts.multiple)
      source = source.add(
        luts.multiple
          .sample(
            toSubUv(
              vec2(muS.mul(0.5).add(0.5), clamp(height.div(Rt - Rg), 0, 1)),
              vec2(MULTIPLE_SIZE),
            ),
          )
          .level(float(0))
          .rgb.mul(scattering),
      )
    const step = exp(air.extinction.mul(dt).negate()),
      integral = step.oneMinus().div(max(air.extinction, vec3(1e-7)))
    light.addAssign(throughput.mul(source).mul(integral))
    transfer.addAssign(throughput.mul(scattering).mul(integral))
    throughput.mulAssign(step)
  })
  if (ground)
    If(groundHit, () => {
      const p = vec3(0, radius, 0).add(ray.mul(distance)),
        up = p.div(length(p)),
        muS = up.dot(sun)
      light.addAssign(
        throughput
          .mul(sunlight(float(Rg), muS))
          .mul(max(muS, 0))
          .mul(EARTH.groundAlbedo / Math.PI),
      )
    })
  return { light, transfer }
}

/**
 * Hillaire's LUT sky: static transmittance and multiple-scattering tables, plus a
 * sun-relative sky-view table redrawn when the sun moves. Stored values include
 * display exposure so half floats keep twilight precision.
 */
export class SkyAtmosphere {
  readonly uniforms = {
    uSunDirection: uniform(new Vector3(0, 1, 0)),
    uExposure: uniform(1),
  }
  private readonly transmittanceTarget = lutTarget(
    ...TRANSMITTANCE_SIZE,
    'Atmosphere transmittance',
  )
  private readonly multipleTarget = lutTarget(
    MULTIPLE_SIZE,
    MULTIPLE_SIZE,
    'Atmosphere multiple scattering',
  )
  private readonly viewTarget: RenderTarget
  private readonly view: TextureNode
  private readonly viewSize: Node<'vec2'>
  private readonly passes: readonly FullscreenPass[]
  private readonly renderer: FullscreenRenderer
  private staticReady = false
  private readonly renderedSun = new Vector3(0, 2, 0)
  private renderedExposure = -1

  constructor(renderer: FullscreenRenderer, lowPower: boolean) {
    this.renderer = renderer
    const [width, height] = lowPower ? [128, 72] : [192, 108]
    this.viewTarget = lutTarget(width, height, 'Atmosphere sky view')
    this.viewSize = vec2(width, height)
    this.view = texture(this.viewTarget.texture)
    const transmittance = texture(this.transmittanceTarget.texture),
      multiple = texture(this.multipleTarget.texture)
    const transmittancePass = Fn(() => {
      const coord = uv(),
        rho = coord.y.mul(TOP_HORIZON),
        radius = sqrt(rho.mul(rho).add(Rg * Rg)),
        near = float(Rt).sub(radius),
        distance = near.add(coord.x.mul(rho.add(TOP_HORIZON).sub(near))),
        mu = clamp(
          float(TOP_HORIZON * TOP_HORIZON)
            .sub(rho.mul(rho))
            .sub(distance.mul(distance))
            .div(max(radius.mul(distance).mul(2), 1e-6)),
          -1,
          1,
        )
      const depth = vec3(0).toVar(),
        dt = distance.div(40)
      Loop(40, ({ i }) => {
        const t = float(i).add(0.5).mul(dt),
          h = sqrt(radius.mul(radius).add(t.mul(t)).add(radius.mul(mu).mul(t).mul(2))).sub(Rg)
        depth.addAssign(medium(h).extinction.mul(dt))
      })
      return vec4(exp(depth.negate()), 1)
    })()
    const multiplePass = Fn(() => {
      const unit = clamp(fromSubUv(uv(), vec2(MULTIPLE_SIZE)), 0, 1),
        muS = unit.x.mul(2).sub(1),
        radius = max(float(Rg).add(unit.y.mul(Rt - Rg)), Rg + 0.01),
        sun = vec3(sqrt(max(muS.mul(muS).oneMinus(), 0)), muS, 0)
      const light = vec3(0).toVar(),
        transfer = vec3(0).toVar()
      Loop(64, ({ i }) => {
        // The march's own loop index shadows `i` in WGSL; resolve the direction first.
        const index = float(i),
          polar = index.mod(8),
          theta = index
            .sub(polar)
            .div(8)
            .add(0.5)
            .mul((2 * Math.PI) / 8),
          phi = acos(float(1).sub(polar.add(0.5).mul(2 / 8))),
          ray = vec3(cos(theta).mul(sin(phi)), cos(phi), sin(theta).mul(sin(phi))).toVar()
        const result = integrate({
          radius,
          ray,
          sun,
          steps: 20,
          luts: { transmittance },
          isotropic: true,
          ground: true,
        })
        light.addAssign(result.light.div(64))
        transfer.addAssign(result.transfer.div(64))
      })
      return vec4(light.div(max(transfer.oneMinus(), vec3(1e-4))), 1)
    })()
    const u = this.uniforms
    const viewPass = Fn(() => {
      const unit = clamp(fromSubUv(uv(), this.viewSize), 0, 1),
        below = unit.y.greaterThanEqual(0.5),
        zenith = below.select(
          unit.y.mul(2).sub(1).pow2().mul(BETA).add(ZENITH_HORIZON),
          float(1)
            .sub(float(1).sub(unit.y.mul(2)).pow2())
            .mul(ZENITH_HORIZON),
        ),
        lightCos = float(1).sub(unit.x.mul(unit.x).mul(2)),
        ray = vec3(
          sin(zenith).mul(lightCos),
          cos(zenith),
          sin(zenith).mul(sqrt(max(lightCos.mul(lightCos).oneMinus(), 0))),
        ),
        muS = clamp(u.uSunDirection.y, -1, 1),
        sun = vec3(sqrt(max(muS.mul(muS).oneMinus(), 0)), muS, 0)
      const { light } = integrate({
        radius: float(VIEW_RADIUS),
        ray,
        sun,
        steps: lowPower ? 20 : 32,
        luts: { transmittance, multiple },
      })
      return vec4(light.mul(u.uExposure), 1)
    })()
    this.passes = [
      new FullscreenPass(renderer, transmittancePass),
      new FullscreenPass(renderer, multiplePass),
      new FullscreenPass(renderer, viewPass),
    ]
  }

  private get targets() {
    return [this.transmittanceTarget, this.multipleTarget, this.viewTarget] as const
  }

  /** Exposed sky radiance in `direction`, relative to the current sun. */
  radiance(direction: Node<'vec3'>, elevation?: Node<'float'>) {
    const sun = this.uniforms.uSunDirection
    const y = elevation ?? direction.y,
      zenith = acos(clamp(y, -1, 1)),
      v = zenith.lessThan(ZENITH_HORIZON).select(
        float(0.5).sub(sqrt(max(float(1).sub(zenith.div(ZENITH_HORIZON)), 0)).mul(0.5)),
        sqrt(max(zenith.sub(ZENITH_HORIZON).div(BETA), 0))
          .mul(0.5)
          .add(0.5),
      )
    const flat = vec2(direction.x, direction.z),
      sunFlat = vec2(sun.x, sun.z),
      cosine = clamp(flat.dot(sunFlat).div(max(length(flat).mul(length(sunFlat)), 1e-5)), -1, 1),
      u = sqrt(float(0.5).sub(cosine.mul(0.5)))
    return this.view.sample(toSubUv(vec2(u, v), this.viewSize)).level(float(0)).rgb
  }

  /** The horizon band behind distant terrain in `direction`. */
  horizon(direction: Node<'vec3'>) {
    return this.radiance(direction, float(0.02))
  }

  async compileAsync() {
    await Promise.all(
      this.passes.map((pass, index) => pass.compileAsync(this.targets[index] ?? null)),
    )
  }

  private draw(index: number) {
    const previous = this.renderer.getRenderTarget(),
      face = this.renderer.getActiveCubeFace(),
      mip = this.renderer.getActiveMipmapLevel()
    try {
      this.renderer.setRenderTarget(this.targets[index] ?? null)
      this.passes[index]?.render()
    } finally {
      this.renderer.setRenderTarget(previous, face, mip)
    }
  }

  update(sunDirection: Vector3, exposure: number) {
    if (!this.staticReady) {
      this.draw(0)
      this.draw(1)
      this.staticReady = true
    }
    if (
      this.renderedSun.distanceToSquared(sunDirection) < 1e-8 &&
      Math.abs(this.renderedExposure - exposure) < 1e-5
    )
      return
    this.uniforms.uSunDirection.value.copy(sunDirection)
    this.uniforms.uExposure.value = exposure
    this.renderedSun.copy(sunDirection)
    this.renderedExposure = exposure
    this.draw(2)
  }

  dispose() {
    for (const target of this.targets) target.dispose()
    for (const pass of this.passes) pass.dispose()
  }
}
