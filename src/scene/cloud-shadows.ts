import {
  Break,
  Fn,
  If,
  Loop,
  clamp,
  exp,
  float,
  min,
  mix,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  LinearFilter,
  ConvertNode,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  Vector3,
} from 'three/webgpu'
import type {
  Camera,
  DirectionalLight,
  MeshStandardNodeMaterial,
  Node,
  UniformNode,
  WebGPURenderer,
} from 'three/webgpu'

import { required } from '../invariant'
import type { CloudVolume } from './cloud-density'
import { distantLightVisibility } from './distant-horizon'

export const CLOUD_SHADOW_SIZE = 768
const TILE = 384
const CENTER = new Vector3(0, 40, -120)
export type CloudRenderer = Pick<
  WebGPURenderer,
  | 'coordinateSystem'
  | 'autoClear'
  | 'getRenderTarget'
  | 'getScissorTest'
  | 'setScissorTest'
  | 'getActiveCubeFace'
  | 'getActiveMipmapLevel'
  | 'setRenderTarget'
  | 'render'
  | 'compileAsync'
> & { readonly xr: { enabled: boolean } }
export function cloudShadowFrame(direction: Vector3) {
  const right = new Vector3(direction.z, 0, -direction.x).normalize()
  if (right.lengthSq() < 0.5) right.set(1, 0, 0)
  const up = new Vector3().crossVectors(direction, right).normalize()
  const matrix = new Matrix4().set(
    right.x / CLOUD_SHADOW_SIZE,
    right.y / CLOUD_SHADOW_SIZE,
    right.z / CLOUD_SHADOW_SIZE,
    0.5 - right.dot(CENTER) / CLOUD_SHADOW_SIZE,
    up.x / CLOUD_SHADOW_SIZE,
    up.y / CLOUD_SHADOW_SIZE,
    up.z / CLOUD_SHADOW_SIZE,
    0.5 - up.dot(CENTER) / CLOUD_SHADOW_SIZE,
    direction.x,
    direction.y,
    direction.z,
    -direction.dot(CENTER),
    0,
    0,
    0,
    1,
  )
  return { matrix, right, up }
}
export class CloudShadows {
  private readonly atlas = new RenderTarget(TILE * 3, TILE, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })
  private readonly matrices = [new Matrix4(), new Matrix4(), new Matrix4()]
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material = new MeshBasicNodeMaterial({
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  private readonly right = uniform(new Vector3())
  private readonly up = uniform(new Vector3())
  readonly uniforms = {
    uHorizonDirection: uniform(new Vector3(0, 1, 0)),
    uHorizonSeed: uniform(0),
    uHorizonMobile: uniform(0),
    uCloudShadowAtlas: texture(this.atlas.texture),
    uCloudShadowPreviousOffset: uniform(0),
    uCloudShadowNextOffset: uniform(1 / 3),
    uCloudShadowPreviousMatrix: uniform(required(this.matrices[0])),
    uCloudShadowNextMatrix: uniform(required(this.matrices[1])),
    uCloudShadowBlend: uniform(0),
    uCloudShadowStrength: uniform(0.95),
  }
  private readonly renderer: CloudRenderer
  private readonly volume: CloudVolume
  constructor(renderer: CloudRenderer, volume: CloudVolume, blend: UniformNode<'float', number>) {
    this.renderer = renderer
    this.volume = volume
    this.uniforms.uCloudShadowBlend = blend
    this.atlas.texture.name = 'Light-space cloud transmission atlas'
    this.atlas.scissorTest = true
    this.material.vertexNode = vec4(uv().mul(vec2(2, -2)).add(vec2(-1, 1)), 0, 1)
    this.material.fragmentNode = Fn(() => {
      const transmission = float(1).toVar()
      const direction = volume.uniforms.uMoonDirection
      If(direction.y.greaterThan(0.0001), () => {
        const ground = vec3(CENTER).add(
          this.right
            .mul(uv().x.sub(0.5))
            .add(this.up.mul(uv().y.sub(0.5)))
            .mul(CLOUD_SHADOW_SIZE),
        )
        const stride = min(float(60).div(direction.y), 2400).div(32)
        const entry = clamp(float(80).sub(ground.y).div(direction.y), -12000, 12000)
        const opticalDepth = float(0).toVar()
        Loop(32, ({ i }) => {
          opticalDepth.addAssign(
            volume
              .density(ground.add(direction.mul(entry.add(float(i).add(0.5).mul(stride)))), true)
              .mul(stride)
              .mul(0.055),
          )
          If(opticalDepth.greaterThan(5), () => {
            Break()
          })
        })
        transmission.assign(exp(opticalDepth.negate()))
      })
      return vec4(vec3(transmission), 1)
    })()
    this.scene.add(new Mesh(this.geometry, this.material))
  }
  capture(index: number) {
    const previous = this.renderer.getRenderTarget(),
      face = this.renderer.getActiveCubeFace(),
      mip = this.renderer.getActiveMipmapLevel()
    const scissorTest = this.renderer.getScissorTest(),
      autoClear = this.renderer.autoClear
    try {
      const frame = cloudShadowFrame(this.volume.uniforms.uMoonDirection.value)
      required(this.matrices[index]).copy(frame.matrix)
      this.right.value.copy(frame.right)
      this.up.value.copy(frame.up)
      this.atlas.viewport.set(index * TILE, 0, TILE, TILE)
      this.atlas.scissor.copy(this.atlas.viewport)
      this.renderer.autoClear = false
      this.renderer.setScissorTest(true)
      this.renderer.setRenderTarget(this.atlas)
      this.renderer.render(this.scene, this.camera)
    } finally {
      this.renderer.setRenderTarget(previous, face, mip)
      this.renderer.setScissorTest(scissorTest)
      this.renderer.autoClear = autoClear
    }
  }
  select(previous: number, next: number) {
    this.uniforms.uCloudShadowPreviousOffset.value = previous / 3
    this.uniforms.uCloudShadowNextOffset.value = next / 3
    this.uniforms.uCloudShadowPreviousMatrix.value = required(this.matrices[previous])
    this.uniforms.uCloudShadowNextMatrix.value = required(this.matrices[next])
  }
  /** Public light color nodes keep celestial occlusion out of local lamp lighting. */
  applyToLight(light: DirectionalLight) {
    const intensity = uniform(light.intensity).onFrameUpdate(() => light.intensity)
    const colorNode = uniform(light.color)
      .rgb.mul(intensity)
      .mul(cloudShadow(positionWorld, this.uniforms))
      .mul(celestialVisibility(this.uniforms))
    Object.assign(light, { colorNode })
  }
  applyTo(material: MeshStandardNodeMaterial, mainCamera?: Camera) {
    material.aoNode = mix(0.35, 1, cloudShadow(positionWorld, this.uniforms))
    if (mainCamera) {
      const reflectionFog = uniform(1).onRenderUpdate(({ camera }) =>
        camera === mainCamera ? 0 : 1,
      )
      const setupFog = material.setupFog.bind(material)
      const cacheKey = material.customProgramCacheKey.bind(material)
      // The main view receives volumetric air after the scene pass. Reflection
      // cameras still need material fog because they do not run that composition.
      material.setupFog = (builder, output) =>
        mix(
          new ConvertNode<'vec4'>(output, 'vec4'),
          new ConvertNode<'vec4'>(setupFog(builder, output), 'vec4'),
          reflectionFog,
        )
      material.customProgramCacheKey = () => `${cacheKey()}:reflection-fog:${mainCamera.uuid}`
      material.needsUpdate = true
    }
  }
  async compileAsync() {
    const previous = this.renderer.getRenderTarget(),
      face = this.renderer.getActiveCubeFace(),
      mip = this.renderer.getActiveMipmapLevel()
    let compiled: Promise<void>
    try {
      this.renderer.setRenderTarget(this.atlas)
      compiled = this.renderer.compileAsync(this.scene, this.camera)
    } finally {
      this.renderer.setRenderTarget(previous, face, mip)
    }
    await compiled
  }
  dispose() {
    this.atlas.dispose()
    this.material.dispose()
    this.geometry.dispose()
  }
}
export type CloudShadowUniforms = CloudShadows['uniforms']
export function celestialVisibility(u: CloudShadowUniforms) {
  return distantLightVisibility(u.uHorizonDirection, u.uHorizonSeed, u.uHorizonMobile)
}
export function cloudShadowProjected(
  previous: Node<'vec2'>,
  next: Node<'vec2'>,
  u: CloudShadowUniforms,
) {
  const sample = (point: Node<'vec2'>, offset: Node<'float'>) => {
    const edge = min(min(point.x, point.y), min(point.x.oneMinus(), point.y.oneMinus()))
    const coord = clamp(point, 0.5 / TILE, 1 - 0.5 / TILE)
    return mix(
      1,
      u.uCloudShadowAtlas.sample(coord.mul(vec2(1 / 3, 1)).add(vec2(offset, 0))).r,
      smoothstep(0, 0.06, edge),
    )
  }
  return mix(
    1,
    mix(
      sample(previous, u.uCloudShadowPreviousOffset),
      sample(next, u.uCloudShadowNextOffset),
      u.uCloudShadowBlend,
    ),
    u.uCloudShadowStrength,
  )
}
export function cloudShadow(world: Node<'vec3'>, u: CloudShadowUniforms) {
  return cloudShadowProjected(
    u.uCloudShadowPreviousMatrix.mul(vec4(world, 1)).xy,
    u.uCloudShadowNextMatrix.mul(vec4(world, 1)).xy,
    u,
  )
}
