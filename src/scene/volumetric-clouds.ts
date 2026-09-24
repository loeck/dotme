import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  cubeTexture,
  sign,
  exp,
  float,
  max,
  min,
  mix,
  normalize,
  positionLocal,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  BackSide,
  CubeCamera,
  CubeRenderTarget,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
} from 'three/webgpu'
import type { Node } from 'three/webgpu'

import { required } from '../invariant'
import { createCloudVolume } from './cloud-density'
import { createCloudNoise } from './cloud-noise'
import type { CloudRenderer } from './cloud-shadows'
import { CloudShadows } from './cloud-shadows'
import { sampleLighting } from './lighting'
import type { LightingState } from './lighting'
import type { WeatherPreset } from './weather'
import type { WindModel } from './wind'

export const CLOUD_PROFILES = {
  desktop: { resolution: 256, hz: 15, steps: 48 },
  mobile: { resolution: 128, hz: 10, steps: 24 },
} as const
export function sampleCloudDisplacement(wind: WindModel, time: number): [number, number] {
  const initial = wind.sample(0),
    drift = Math.max(0, 2.2 - initial.speed) * time
  const current = wind.sample(time).displacement
  return [current[0] + initial.direction[0] * drift, current[1] + initial.direction[1] * drift]
}
const decode = (sample: Node<'vec4'>) => vec4(sample.rgb.mul(sample.rgb).mul(16), sample.a)
/** Cubic reconstruction in each face plane; edge weights keep cube seams continuous. */
function smoothCloud(
  map: ReturnType<typeof cubeTexture>,
  ray: Node<'vec3'>,
  resolution: Node<'float'>,
) {
  return Fn(() => {
    const absolute = abs(ray),
      major = max(max(absolute.x, absolute.y), absolute.z)
    const weight = smoothstep(
      vec3(major.mul(float(1).sub(float(4).div(resolution)))),
      vec3(major),
      absolute,
    )
    const result = vec4(0).toVar()
    const face = (normal: Node<'vec3'>, tangent: Node<'vec3'>, bitangent: Node<'vec3'>) => {
      const coord = vec2(ray.dot(tangent), ray.dot(bitangent)).div(ray.dot(normal))
      const texel = coord.mul(0.5).add(0.5).mul(resolution).sub(0.5),
        f = texel.fract(),
        base = texel.floor()
      const w0 = f.oneMinus().pow(3).div(6),
        w1 = f.pow(3).mul(3).sub(f.pow(2).mul(6)).add(4).div(6)
      const w2 = f.pow(3).mul(-3).add(f.pow(2).mul(3)).add(f.mul(3)).add(1).div(6),
        w3 = f.pow(3).div(6)
      const g0 = w0.add(w1),
        g1 = w2.add(w3)
      const low = base.sub(0.5).add(w1.div(g0)).mul(float(2).div(resolution)).sub(1),
        high = base.add(1.5).add(w3.div(g1)).mul(float(2).div(resolution)).sub(1)
      const sample = (x: Node<'float'>, y: Node<'float'>) =>
        decode(map.sample(normal.add(tangent.mul(x)).add(bitangent.mul(y))))
      return sample(low.x, low.y)
        .mul(g0.x)
        .mul(g0.y)
        .add(sample(high.x, low.y).mul(g1.x).mul(g0.y))
        .add(sample(low.x, high.y).mul(g0.x).mul(g1.y))
        .add(sample(high.x, high.y).mul(g1.x).mul(g1.y))
    }
    If(weight.x.greaterThan(0), () => {
      result.addAssign(face(vec3(sign(ray.x), 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)).mul(weight.x))
    })
    If(weight.y.greaterThan(0), () => {
      result.addAssign(face(vec3(0, sign(ray.y), 0), vec3(1, 0, 0), vec3(0, 0, 1)).mul(weight.y))
    })
    If(weight.z.greaterThan(0), () => {
      result.addAssign(face(vec3(0, 0, sign(ray.z)), vec3(1, 0, 0), vec3(0, 1, 0)).mul(weight.z))
    })
    return result.div(weight.x.add(weight.y).add(weight.z))
  })()
}
export class VolumetricClouds {
  readonly shadows: CloudShadows
  readonly profile: (typeof CLOUD_PROFILES)[keyof typeof CLOUD_PROFILES]
  readonly uniforms
  private readonly targets: CubeRenderTarget[]
  private readonly noise
  private readonly volume
  private readonly material = new MeshBasicNodeMaterial({
    side: BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly geometry = new SphereGeometry(1, 16, 8)
  private readonly scene = new Scene()
  private readonly camera: CubeCamera
  private tick = -1
  private current = 0
  private next = 1
  private staging = 2
  private preparedParts = 0
  private readonly renderer: CloudRenderer
  private readonly wind: WindModel
  private readonly lighting: (time: number) => LightingState

  constructor(
    renderer: CloudRenderer,
    seed: number,
    mobile: boolean,
    wind: WindModel,
    lighting: (time: number) => LightingState = (time) => sampleLighting(0, time),
    weather: WeatherPreset = 'partly-cloudy',
    noiseData?: Uint8Array,
  ) {
    this.renderer = renderer
    this.wind = wind
    this.lighting = lighting
    this.profile = mobile ? CLOUD_PROFILES.mobile : CLOUD_PROFILES.desktop
    this.noise = createCloudNoise(seed, 32, noiseData)
    this.targets = [0, 1, 2].map(
      () =>
        new CubeRenderTarget(this.profile.resolution, {
          type: HalfFloatType,
          minFilter: LinearFilter,
          magFilter: LinearFilter,
          generateMipmaps: false,
          depthBuffer: false,
          stencilBuffer: false,
        }),
    )
    for (const target of this.targets)
      target.texture.name = 'Volumetric cloud radiance / transmission'
    this.uniforms = {
      uCloudPrevious: cubeTexture(required(this.targets[0]).texture),
      uCloudNext: cubeTexture(required(this.targets[1]).texture),
      uCloudBlend: uniform(0),
      uCloudResolution: uniform(this.profile.resolution),
      uCloudEnabled: uniform(weather === 'clear' ? 0 : 1),
    }
    this.camera = new CubeCamera(0.1, 2, required(this.targets[0]))
    this.volume = createCloudVolume(seed, weather, this.noise)
    const { density, uniforms: u } = this.volume
    this.material.fragmentNode = Fn(() => {
      const ray = normalize(positionLocal),
        radiance = vec3(0).toVar(),
        transmission = float(1).toVar()
      If(ray.y.greaterThan(0.035), () => {
        const entry = float(80).div(ray.y),
          exit = min(float(140).div(ray.y), 2200)
        If(entry.lessThan(exit), () => {
          const stride = exit.sub(entry).div(this.profile.steps)
          const phase = float(0.75).div(
            max(0.05, float(1.25).sub(ray.dot(u.uMoonDirection))).pow(1.5),
          )
          Loop(this.profile.steps, ({ i }) => {
            const p = ray.mul(entry.add(float(i).add(0.5).mul(stride)))
            const d = density(p, true)
            If(d.greaterThan(0.001), () => {
              const optical = float(0).toVar()
              Loop(3, ({ i: j }) => {
                optical.addAssign(
                  density(p.add(u.uMoonDirection.mul(float(j).mul(22).add(8))), false).mul(
                    float(j).mul(12).add(9),
                  ),
                )
              })
              const moon = exp(optical.mul(-0.055)),
                sky = exp(density(p.add(vec3(0, 18, 0)), false).mul(-18 * 0.055))
              const source = u.uCloudAmbient.rgb
                .mul(sky.mul(1.65).add(0.25))
                .add(u.uCloudDirect.rgb.mul(moon).mul(phase.mul(0.35).add(0.3)))
              const opacity = exp(d.mul(stride).mul(-0.055)).oneMinus()
              radiance.addAssign(transmission.mul(opacity).mul(source))
              transmission.mulAssign(opacity.oneMinus())
              If(transmission.lessThan(0.015), () => {
                Break()
              })
            })
          })
        })
      })
      const fade = smoothstep(0.035, 0.075, ray.y)
      return vec4(sqrt(max(radiance.mul(fade), vec3(0)).div(16)), mix(1, transmission, fade))
    })()
    this.shadows = new CloudShadows(renderer, this.volume, this.uniforms.uCloudBlend)
    this.shadows.uniforms.uCloudShadowStrength.value = weather === 'clear' ? 0 : 1
    this.shadows.uniforms.uHorizonSeed.value = (seed % 4096) / 379
    this.shadows.uniforms.uHorizonMobile.value = mobile ? 1 : 0
    const sphere = new Mesh(this.geometry, this.material)
    sphere.frustumCulled = false
    this.scene.add(sphere)
  }
  sample(direction: Node<'vec3'>) {
    return mix(
      vec4(0, 0, 0, 1),
      mix(
        smoothCloud(this.uniforms.uCloudPrevious, direction, this.uniforms.uCloudResolution),
        smoothCloud(this.uniforms.uCloudNext, direction, this.uniforms.uCloudResolution),
        this.uniforms.uCloudBlend,
      ),
      this.uniforms.uCloudEnabled,
    )
  }
  private setCaptureTime(time: number) {
    const u = this.volume.uniforms
    u.uDisplacement.value.fromArray(sampleCloudDisplacement(this.wind, time))
    u.uTime.value = time
    const light = this.lighting(time)
    u.uMoonDirection.value.copy(light.direction)
    u.uCloudAmbient.value.copy(light.cloudAmbient)
    u.uCloudDirect.value.copy(light.cloudDirect)
  }
  private capture(index: number, time: number) {
    const staging = this.staging,
      prepared = this.preparedParts
    this.staging = index
    this.preparedParts = 0
    try {
      this.prepareParts(time, 7)
    } finally {
      this.staging = staging
      this.preparedParts = prepared
    }
  }
  private prepareParts(time: number, count: number) {
    this.setCaptureTime(time)
    if (this.camera.coordinateSystem !== this.renderer.coordinateSystem) {
      this.camera.coordinateSystem = this.renderer.coordinateSystem
      this.camera.updateCoordinateSystem()
    }
    this.camera.updateMatrixWorld()
    const target = this.renderer.getRenderTarget(),
      face = this.renderer.getActiveCubeFace(),
      mip = this.renderer.getActiveMipmapLevel(),
      xr = this.renderer.xr.enabled
    try {
      this.renderer.xr.enabled = false
      while (this.preparedParts < count) {
        const part = this.preparedParts
        if (part < 6) {
          const camera = this.camera.children[part]
          if (!(camera instanceof PerspectiveCamera)) throw new Error('Missing cloud cube camera')
          this.renderer.setRenderTarget(required(this.targets[this.staging]), part)
          this.renderer.render(this.scene, camera)
        } else this.shadows.capture(this.staging)
        this.preparedParts++
      }
    } finally {
      this.renderer.xr.enabled = xr
      this.renderer.setRenderTarget(target, face, mip)
    }
  }
  update(time: number) {
    const light = this.lighting(time)
    this.shadows.uniforms.uHorizonDirection.value.copy(light.direction)
    if (!this.uniforms.uCloudEnabled.value) return
    this.shadows.uniforms.uCloudShadowStrength.value = Math.max(
      light.sunIntensity / 4.5,
      light.moonIntensity / 1.4,
    )
    const tick = Math.floor(time * this.profile.hz)
    if (this.tick !== tick) {
      if (tick === this.tick + 1 && this.tick >= 0) {
        this.prepareParts((tick + 1) / this.profile.hz, 7)
        const old = this.current
        this.current = this.next
        this.next = this.staging
        this.staging = old
      } else {
        this.current = 0
        this.next = 1
        this.staging = 2
        this.capture(this.current, tick / this.profile.hz)
        this.capture(this.next, (tick + 1) / this.profile.hz)
      }
      this.preparedParts = 0
      this.shadows.select(this.current, this.next)
      this.tick = tick
      this.uniforms.uCloudPrevious.value = required(this.targets[this.current]).texture
      this.uniforms.uCloudNext.value = required(this.targets[this.next]).texture
    }
    const fraction = Math.max(0, Math.min(1, time * this.profile.hz - tick))
    this.uniforms.uCloudBlend.value = fraction
    this.prepareParts(
      (tick + 2) / this.profile.hz,
      Math.min(7, Math.ceil((fraction + this.profile.hz / 60) * 7)),
    )
  }
  async compileAsync() {
    if (!this.uniforms.uCloudEnabled.value) return
    if (this.camera.coordinateSystem !== this.renderer.coordinateSystem) {
      this.camera.coordinateSystem = this.renderer.coordinateSystem
      this.camera.updateCoordinateSystem()
    }
    const camera = this.camera.children[0]
    if (!(camera instanceof PerspectiveCamera)) throw new Error('Missing cloud cube camera')
    const previous = this.renderer.getRenderTarget(),
      face = this.renderer.getActiveCubeFace(),
      mip = this.renderer.getActiveMipmapLevel()
    let compiled: Promise<void>
    try {
      this.renderer.setRenderTarget(required(this.targets[0]), 0)
      compiled = this.renderer.compileAsync(this.scene, camera)
    } finally {
      this.renderer.setRenderTarget(previous, face, mip)
    }
    await compiled
    await this.shadows.compileAsync()
  }
  dispose() {
    this.shadows.dispose()
    this.noise.dispose()
    this.geometry.dispose()
    this.material.dispose()
    for (const target of this.targets) target.dispose()
  }
}
