import {
  Discard,
  Fn,
  depth,
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  cross,
  dFdx,
  dFdy,
  exp,
  float,
  fwidth,
  length,
  mat3,
  max,
  min,
  mix,
  normalize,
  renderOutput,
  positionLocal,
  screenCoordinate,
  sin,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { Color, DepthTexture, Node, Vector2, Vector3 } from 'three/webgpu'
import {
  MeshBasicNodeMaterial,
  DoubleSide,
  CustomBlending,
  OneFactor,
  ReinhardToneMapping,
  SRGBColorSpace,
} from 'three/webgpu'

import type { LakeWaterMaterial } from './lake-water'
import { IMPACT_LIFETIME } from './rain-simulation'
import { fieldUvNode, windFieldNode } from './water-surface'

export const RAIN_EXPOSURE = 1 / 90
export const RAIN_CROWN_LIFETIME = 0.13
export const RAIN_SPRAY_LIFETIME = 0.18
export type RainSurface = Pick<
  LakeWaterMaterial['uniforms'],
  | 'uTime'
  | 'uState'
  | 'uMask'
  | 'uCell'
  | 'uWindRotation'
  | 'uWindRotationVelocity'
  | 'uWindResponse'
>
export function createRainUniforms(
  surface: RainSurface,
  resolution: Vector2,
  moonColor: Color,
  moonDirection: Vector3,
  lampPositions: Vector3[],
  lampColors: Color[],
  depthTexture: DepthTexture,
) {
  return {
    ...surface,
    uResolution: uniform(resolution),
    uPixelRatio: uniform(1),
    uMoonColor: uniform(moonColor),
    uMoonDirection: uniform(moonDirection),
    uLampPosition: uniformArray<'vec3'>(lampPositions, 'vec3'),
    uLampColor: uniformArray<'color'>(lampColors, 'color'),
    uDepth: texture(depthTexture),
    uOverlay: uniform(false),
    uReflectionPass: uniform(false),
    uOpacity: uniform(1),
  }
}
type RainUniforms = ReturnType<typeof createRainUniforms>
function heightAt(p: Node<'vec2'>, u: RainSurface) {
  return windFieldNode(p, float(0), u).x.add(u.uState.sample(fieldUvNode(p)).r)
}
function rainLight(world: Node<'vec3'>, u: RainUniforms, lampCount: number) {
  const view = normalize(cameraPosition.sub(world))
  let light = u.uMoonColor.rgb.mul(abs(view.dot(u.uMoonDirection)).pow(5).mul(0.65).add(0.35))
  for (let i = 0; i < lampCount; i++) {
    const delta = u.uLampPosition.element(i).sub(world),
      glint = abs(view.dot(normalize(delta)))
        .pow(3)
        .mul(0.7)
        .add(0.3)
    light = light.add(u.uLampColor.element(i).rgb.mul(glint).div(delta.dot(delta).add(1)))
  }
  return light.mul(exp(length(cameraPosition.sub(world)).mul(-0.009)))
}
function rainOutput(output: Node<'vec4'>, u: RainUniforms) {
  return u.uOverlay.select(renderOutput(output, ReinhardToneMapping, SRGBColorSpace), output)
}
function occlude(u: RainUniforms) {
  Discard(
    u.uOverlay.and(
      depth.greaterThan(u.uDepth.sample(screenCoordinate.xy.div(u.uResolution)).r.add(0.000001)),
    ),
  )
}
export function createRainParticleMaterial(
  kind: 'streak' | 'crown' | 'spray',
  u: RainUniforms,
  lampCount: number,
) {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    forceSinglePass: true,
  })
  if (kind === 'crown') {
    material.name = 'RainCrowns'
    const impact = attribute('aImpact', 'vec4'),
      arrival = attribute('aArrival', 'vec4'),
      age = impact.z,
      life = age.div(RAIN_CROWN_LIFETIME),
      angle = uv().x.mul(Math.PI * 2),
      scale = impact.w.div(0.003)
    const radial = vec2(cos(angle), sin(angle)),
      teeth = sin(angle.mul(7).add(arrival.z.mul(31)))
        .mul(0.28)
        .add(0.72)
    const radius = age.mul(0.1).add(uv().y.mul(0.004)).add(0.006).mul(scale)
    const height = sin(clamp(life, 0, 1).mul(Math.PI))
        .mul(0.018)
        .mul(teeth)
        .mul(uv().y)
        .mul(scale),
      drift = arrival.xy.mul(age).mul(0.035).mul(uv().y)
    const xz = impact.xy.add(radial.mul(radius)).add(drift)
    const world = varying(vec3(xz.x, height.add(-0.032).add(heightAt(xz, u)), xz.y))
    material.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(world, 1)))
    const fade = varying(smoothstep(0.045, RAIN_CROWN_LIFETIME, age).oneMinus())
    material.fragmentNode = Fn(() => {
      occlude(u)
      const rim = smoothstep(0.55, 1, uv().y),
        normal = normalize(cross(dFdx(world), dFdy(world))),
        grazing = abs(normal.dot(normalize(cameraPosition.sub(world)))).oneMinus()
      const fresnel = grazing.pow(5).mul(0.97963).add(0.02037)
      return rainOutput(
        vec4(
          rainLight(world, u, lampCount),
          rim.mul(0.24).add(0.04).mul(sqrt(fresnel).mul(0.7).add(0.3)).mul(fade).mul(u.uOpacity),
        ),
        u,
      )
    })()
    return material
  }
  material.name = kind === 'spray' ? 'RainSpray' : 'RainStreaks'
  const drop = attribute('aDrop', 'vec4'),
    velocity = attribute('aVelocity', 'vec4')
  const world = kind === 'spray' ? vec3(drop.x, drop.y.add(heightAt(drop.xz, u)), drop.z) : drop.xyz
  const exposure =
    kind === 'spray'
      ? float(RAIN_EXPOSURE)
      : max(0, float(RAIN_EXPOSURE).sub(max(0, attribute('aContactAge', 'float'))))
  const head = cameraViewMatrix.mul(vec4(world, 1)),
    motion = mat3(cameraViewMatrix).mul(velocity.xyz).mul(exposure)
  const tailClip = cameraProjectionMatrix.mul(vec4(head.xyz.sub(motion), 1)),
    headClip = cameraProjectionMatrix.mul(head)
  const screenMotion = headClip.xy
      .div(headClip.w)
      .sub(tailClip.xy.div(tailClip.w))
      .mul(u.uResolution)
      .mul(0.5),
    streak = length(screenMotion)
  const direction = streak
    .greaterThan(0.001)
    .select(screenMotion.div(max(streak, 0.001)), vec2(0, -1))
  const physical = drop.w
    .mul(cameraProjectionMatrix.mul(vec4(0, 1, 0, 0)).y)
    .mul(u.uResolution.y)
    .mul(0.5)
    .div(max(0.1, head.z.negate()))
  const coc = smoothstep(0.8, 4, head.z.negate())
    .oneMinus()
    .mul(0.65)
    .mul(u.uPixelRatio)
    .mul(kind === 'spray' ? 0.22 : 1)
  const width = u.uReflectionPass.select(
    physical.add(2),
    sqrt(physical.pow(2).add(6.25).add(coc.pow(2).mul(4))),
  )
  const lengthPx = max(streak, 1).add(u.uReflectionPass.select(1, width)),
    side = vec2(direction.y.negate(), direction.x)
  const offset = side
    .mul(positionLocal.x)
    .mul(width)
    .add(direction.mul(positionLocal.y).mul(lengthPx))
  material.vertexNode = vec4(
    headClip.xy.add(
      offset.sub(direction.mul(streak).mul(0.5)).mul(2).div(u.uResolution).mul(headClip.w),
    ),
    headClip.zw,
  )
  const vSide = varying(positionLocal.x.mul(width)),
    vPhysical = varying(physical),
    seed = varying(velocity.w),
    profileContrast = varying(float(1).div(coc.mul(0.5).add(1)))
  const coverage = varying(
    u.uReflectionPass
      .select(1, min(1, physical.div(width)))
      .mul(max(streak, 1))
      .div(lengthPx)
      .mul(exposure)
      .div(RAIN_EXPOSURE),
  )
  const lighting = varying(rainLight(world, u, lampCount))
  material.fragmentNode = Fn(() => {
    occlude(u)
    const pixelSpan = max(fwidth(vSide), 0.0001),
      halfDrop = vPhysical.mul(0.5)
    const integrated = max(
      0,
      min(vSide.add(pixelSpan.mul(0.5)), halfDrop).sub(
        max(vSide.sub(pixelSpan.mul(0.5)), halfDrop.negate()),
      ),
    ).div(pixelSpan)
    const across = u.uReflectionPass.select(
      integrated,
      exp(uv().x.sub(0.5).mul(4.2).pow2().negate()),
    )
    const ends = smoothstep(0, 0.18, uv().y).mul(smoothstep(0.8, 1, uv().y).oneMinus())
    const profile = sin(uv().y.mul(seed.mul(17).add(9)).add(seed.mul(50))).pow2(),
      lobes = mix(0.72, profile.mul(0.65).add(0.35), profileContrast),
      glint = mix(0.75, 1, seed.pow(2))
    const alpha =
      kind === 'spray'
        ? u.uReflectionPass
            .select(
              min(0.85, across.mul(coverage).mul(5.5)),
              across.mul(min(0.85, coverage.mul(13))),
            )
            .mul(ends)
            .mul(u.uOpacity)
        : u.uReflectionPass
            .select(
              min(0.65, across.mul(coverage).mul(2)),
              across.mul(min(0.65, coverage.mul(4.8))),
            )
            .mul(ends)
            .mul(lobes)
            .mul(glint)
            .mul(u.uOpacity)
    return rainOutput(vec4(lighting, alpha), u)
  })()
  return material
}
export function createRainSlopeMaterial(u: RainSurface) {
  const material = new MeshBasicNodeMaterial({
    name: 'RainScreenSlopes',
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: DoubleSide,
    forceSinglePass: true,
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    toneMapped: false,
  })
  const impact = attribute('aImpact', 'vec4'),
    arrival = attribute('aArrival', 'vec4'),
    offset = varying(positionLocal.xy.mul(impact.z.mul(0.75).add(0.38))),
    data = varying(vec4(impact.zw, arrival.zw))
  const xz = impact.xy.add(offset)
  material.vertexNode = cameraProjectionMatrix.mul(
    cameraViewMatrix.mul(vec4(xz.x, heightAt(xz, u).sub(0.035), xz.y, 1)),
  )
  material.fragmentNode = Fn(() => {
    const r = length(offset),
      age = data.x,
      radial = offset.div(max(r, 0.0001)),
      radialPixel = vec2(radial.dot(dFdx(offset)), radial.dot(dFdy(offset)))
    const pixelVariance = radialPixel.dot(radialPixel).div(12),
      size = clamp(data.y.sub(0.0006).div(0.0038), 0, 1),
      energy = clamp(data.w, 0, 1),
      strength = sqrt(energy).mul(0.18),
      duration = mix(0.45, IMPACT_LIFETIME, sqrt(energy))
    const life = smoothstep(0, 0.012, age).mul(
        smoothstep(duration.mul(0.45), duration, age).oneMinus(),
      ),
      slope = float(0).toVar(),
      variance = float(0).toVar()
    for (let i = 0; i < 3; i++) {
      const k = data.z
          .mul(0.2)
          .add(0.9)
          .mul(90 + i * 95),
        omega = sqrt(k.mul(9.81).add(k.pow(3).mul(0.000074))),
        speed = k
          .pow(2)
          .mul(3 * 0.000074)
          .add(9.81)
          .div(omega.mul(2))
      const width = age.mul(0.035).add(0.025),
        packet = r.sub(0.012).sub(speed.mul(age)),
        w2 = width.pow(2),
        filtered = w2.add(pixelVariance),
        frequency = w2.div(filtered)
      const envelope = width
          .div(sqrt(filtered))
          .mul(exp(packet.pow2().negate().div(filtered.mul(2)))),
        filter = exp(k.pow(2).mul(pixelVariance).mul(frequency).mul(-0.5)),
        phase = k.mul(r.sub(packet.mul(pixelVariance).div(filtered))).sub(omega.mul(age))
      const amplitude = strength.mul(life).mul(exp(age.mul(-(2.5 + i * 0.7))))
      slope.addAssign(
        amplitude
          .mul(envelope)
          .mul(filter)
          .mul(frequency.mul(cos(phase)).sub(sin(phase).mul(packet).div(k.mul(filtered)))),
      )
      const energyWidth = w2.add(pixelVariance.mul(2)),
        energyEnvelope = width
          .div(sqrt(energyWidth))
          .mul(exp(packet.pow2().negate().div(energyWidth)))
      variance.addAssign(
        amplitude.pow(2).mul(0.5).mul(energyEnvelope).mul(filter.pow(2).oneMinus()),
      )
    }
    const cavityWidth = size.mul(0.024).add(0.018).add(age.mul(0.1)),
      cavityWidth2 = cavityWidth.pow(2).add(pixelVariance),
      cavityDepth = energy
        .mul(0.005)
        .add(0.0005)
        .mul(life)
        .mul(exp(age.mul(-22)))
    slope.addAssign(
      cavityDepth
        .mul(r)
        .div(cavityWidth2)
        .mul(exp(r.pow(2).negate().div(cavityWidth2.mul(2))))
        .mul(cavityWidth.pow(2))
        .div(cavityWidth2),
    )
    slope.mulAssign(smoothstep(0, 0.008, r))
    return vec4(radial.mul(slope), variance, 0)
  })()
  return material
}
