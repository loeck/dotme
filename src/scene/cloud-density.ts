import {
  Fn,
  If,
  Loop,
  Continue,
  float,
  min,
  mix,
  sin,
  smoothstep,
  texture3D,
  uniform,
  uniformArray,
  vec3,
} from 'three/tsl'
import type { Data3DTexture, Node } from 'three/webgpu'
import { Color, Vector2, Vector3, Vector4 } from 'three/webgpu'

import { WEATHER } from './weather'
import type { WeatherPreset } from './weather'

export const CLOUD_COUNT = 12
export const CLOUD_PERIOD = 640
const CLOUD_BASE = 80
const CLOUD_TOP = 140

/** Separate seeded bodies: large banks and smaller clouds can overtake one another.
 * Periodic copies keep the distant layer populated without respawning or popping. */
export function createCloudBodies(seed: number, weather: WeatherPreset = 'partly-cloudy') {
  let state = (seed ^ 0xc10d5eed) >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
  const origins: Vector4[] = []
  const radii: Vector4[] = []
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const large = i % 3 === 0
    const radius = large ? 100 + random() * 45 : 28 + random() * 32
    const height = large ? 24 + random() * 5 : 12 + random() * 8
    origins.push(
      new Vector4(
        (((i % 4) + 0.15 + random() * 0.7) * CLOUD_PERIOD) / 4 - CLOUD_PERIOD / 2 - 280,
        CLOUD_BASE + height + random() * (CLOUD_TOP - CLOUD_BASE - height * 2),
        ((Math.floor(i / 4) + 0.15 + random() * 0.7) * CLOUD_PERIOD) / 3 - CLOUD_PERIOD / 2 - 40,
        (large ? 0.55 : 1.15) + random() * 0.45,
      ),
    )
    radii.push(new Vector4(radius, height, radius * (0.6 + random() * 0.45), random() * 10))
  }
  const settings = WEATHER[weather]
  for (const radius of radii) {
    radius.x *= settings.bodyScale
    radius.z *= settings.bodyScale
  }
  return {
    uCloudCoverage: { value: settings.coverage },
    uCloudDensity: { value: settings.density },
    uCloudOrigins: { value: origins },
    uCloudRadii: { value: radii },
  }
}

/** The same TSL density graph drives visible radiance and Beer–Lambert shadows. */
export function createCloudVolume(seed: number, weather: WeatherPreset, noise: Data3DTexture) {
  const bodies = createCloudBodies(seed, weather)
  const uniforms = {
    uCloudCoverage: uniform(bodies.uCloudCoverage.value),
    uCloudDensity: uniform(bodies.uCloudDensity.value),
    uCloudOrigins: uniformArray<'vec4'>(bodies.uCloudOrigins.value, 'vec4'),
    uCloudRadii: uniformArray<'vec4'>(bodies.uCloudRadii.value, 'vec4'),
    uDisplacement: uniform(new Vector2()),
    uTime: uniform(0),
    uMoonDirection: uniform(new Vector3(0, 1, 0)),
    uCloudLightDirection: uniform(new Vector3(0, 1, 0)),
    uCloudAmbient: uniform(new Color()),
    uCloudDirect: uniform(new Color()),
  }
  const density = (world: Node<'vec3'>, detail: boolean, erosion: Node<'float'> = float(0)) =>
    Fn(() => {
      const total = float(0).toVar()
      If(world.y.greaterThan(CLOUD_BASE).and(world.y.lessThan(CLOUD_TOP)), () => {
        const envelope = smoothstep(CLOUD_BASE, CLOUD_BASE + 4, world.y).mul(
          smoothstep(CLOUD_TOP - 4, CLOUD_TOP, world.y).oneMinus(),
        )
        If(uniforms.uCloudCoverage.greaterThan(0), () => {
          const sheetXZ = world.xz.sub(uniforms.uDisplacement.mul(0.7)).div(CLOUD_PERIOD)
          const sheet = texture3D(noise, vec3(sheetXZ.x, 0.37, sheetXZ.y)).rg
          const base = sheet.r.mul(22).add(CLOUD_BASE + 3)
          total.assign(
            uniforms.uCloudCoverage
              .mul(smoothstep(base, base.add(12), world.y))
              .mul(smoothstep(CLOUD_TOP - 12, CLOUD_TOP, world.y).oneMinus())
              .mul(mix(0.22, 1.15, smoothstep(0.2, 0.8, sheet.r)))
              .mul(mix(0.8, 1.1, sheet.g))
              .mul(erosion.oneMinus()),
          )
        })
        Loop(CLOUD_COUNT, ({ i }) => {
          const origin = uniforms.uCloudOrigins.element(i),
            radii = uniforms.uCloudRadii.element(i)
          const p = world.sub(origin.xyz).toVar()
          If(p.y.div(radii.y).pow2().greaterThanEqual(2.65), () => {
            Continue()
          })
          p.xz.subAssign(uniforms.uDisplacement.mul(origin.w))
          p.xz.assign(
            p.xz
              .add(CLOUD_PERIOD / 2)
              .mod(CLOUD_PERIOD)
              .sub(CLOUD_PERIOD / 2),
          )
          const q = p.div(radii.xyz),
            boundary = q.dot(q)
          If(boundary.greaterThanEqual(2.65), () => {
            Continue()
          })
          const noisePoint = p
            .mul(vec3(0.008, 0.016, 0.008))
            .add(radii.w)
            .add(sin(p.zxy.mul(0.015).add(uniforms.uTime.mul(0.035)).add(radii.w)).mul(0.025))
          const sample = texture3D(noise, noisePoint).rg
          const mass = float(0.6)
            .sub(boundary.mul(0.8))
            .add(sample.r.sub(0.5).mul(2.4))
            .add(sample.g.sub(0.5).mul(0.7))
            .sub(erosion.mul(2.2))
            .toVar()
          if (detail) mass.subAssign(texture3D(noise, noisePoint.mul(2.7)).g.oneMinus().mul(0.12))
          total.addAssign(smoothstep(0.03, 0.5, mass).mul(envelope).mul(0.75))
        })
      })
      return min(total.max(0), 1).mul(uniforms.uCloudDensity)
    })()
  return { uniforms, density }
}
export type CloudVolume = ReturnType<typeof createCloudVolume>
