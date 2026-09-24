import {
  cameraProjectionMatrix,
  cross,
  float,
  Fn,
  mix,
  normalize,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  Matrix4,
  Mesh,
  MeshPhysicalNodeMaterial,
  PlaneGeometry,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu'
import type { Camera, Node } from 'three/webgpu'

import { fragmentDepth, screenLinearVarying } from './backend-nodes'
import type { LakeWaterMaterial } from './lake-water'
import type { VoxelWaterfall } from './voxel-world'
import { fieldUvNode, windFieldNode } from './water-surface'
import { WaterfallFluidPass } from './waterfall-fluid-pass'
import { createWaterfallParticles } from './waterfall-particles'

/** Main and reflected views include the fluid; environment probes avoid self-refraction. */
export const WATERFALL_FLUID_LAYER = 6

/** Reconstructs a lit water surface from particle depth and optical thickness. */
export class WaterfallFluid {
  readonly material = new MeshPhysicalNodeMaterial({
    color: 0xffffff,
    ior: 1.333,
    roughness: 0.12,
    metalness: 0,
    transmission: 1,
    attenuationColor: new Color(0.8, 0.94, 0.94),
    attenuationDistance: 2,
    transparent: true,
    depthWrite: true,
    alphaTest: 0.015,
    forceSinglePass: true,
  })
  readonly mesh: Mesh<PlaneGeometry, MeshPhysicalNodeMaterial>
  private readonly particles
  private readonly pass: WaterfallFluidPass
  private readonly projectionInverse = uniform(new Matrix4())
  private readonly localFromView = uniform(new Matrix4())
  private readonly pixel = uniform(new Vector2(1, 1))
  private readonly visible = uniform(0)
  private readonly fallbackDepth = uniform(25)
  private readonly center = new Vector3()
  private readonly viewMatrix = new Matrix4()
  private readonly fall: VoxelWaterfall
  private compilationDepth = 0
  private prepared = false
  private disposed = false

  constructor(fall: VoxelWaterfall, mobile: boolean, time: Node<'float'>, opacity: Node<'float'>) {
    this.fall = fall
    this.particles = createWaterfallParticles(fall, mobile, time)
    this.pass = new WaterfallFluidPass(this.particles, mobile)
    const depth = texture(this.pass.depthTexture)
    const thickness = texture(this.pass.thicknessTexture)
    const vertexUV = vec2(uv().x, uv().y.oneMinus())
    const reconstruct = (coord: Node<'vec2'>) => {
      const sampled = depth.sample(coord).r
      const distance = sampled.greaterThan(0).select(sampled, this.fallbackDepth)
      const ray = this.projectionInverse.mul(vec4(coord.mul(vec2(2, -2)).add(vec2(-1, 1)), 0, 1))
      return ray.xyz.mul(distance.negate().div(ray.z))
    }
    const vertexView = reconstruct(vertexUV)
    this.material.positionNode = this.localFromView.mul(vec4(vertexView, 1)).xyz
    // Raster interpolation must remain linear in screen space as the grid's
    // vertices move to different distances from the camera.
    const point = screenLinearVarying(
      vertexUV,
      cameraProjectionMatrix.mul(vec4(vertexView, 1)).w,
      'waterfallScreenUV',
    )
    const viewPosition = reconstruct(point)
    const data = thickness.sample(point)
    // Overlapping parcel kernels integrate a density estimate. Keep the water
    // and aerated fraction distinct instead of painting whiteness onto a sheet.
    const opticalThickness = data.r.mul(0.6).clamp(0, 1.5)
    const aeration = data.g.div(data.r.max(0.00001)).clamp(0, 1)
    const whitewater = opticalThickness.mul(aeration).mul(-7).exp().oneMinus()
    this.material.thicknessNode = opticalThickness
    this.material.transmissionNode = whitewater.oneMinus().mul(0.96)
    this.material.colorNode = mix(vec3(0.88, 0.96, 0.96), vec3(0.99, 1, 0.99), whitewater)
    this.material.roughnessNode = mix(0.08, 0.42, whitewater)
    this.material.opacityNode = smoothstep(0.004, 0.045, data.r)
      .mul(depth.sample(point).r.greaterThan(0).select(1, 0))
      .mul(opacity)
      .mul(this.visible)
    this.material.normalNode = Fn(() => {
      const center = viewPosition
      const left = reconstruct(point.sub(vec2(this.pixel.x, 0)))
      const right = reconstruct(point.add(vec2(this.pixel.x, 0)))
      const up = reconstruct(point.sub(vec2(0, this.pixel.y)))
      const down = reconstruct(point.add(vec2(0, this.pixel.y)))
      const dx = right.z
        .sub(center.z)
        .abs()
        .lessThan(center.z.sub(left.z).abs())
        .select(right.sub(center), center.sub(left))
      const dy = down.z
        .sub(center.z)
        .abs()
        .lessThan(center.z.sub(up.z).abs())
        .select(down.sub(center), center.sub(up))
      return normalize(cross(dy, dx))
    })()
    // Fragment depth prevents a grid cell from bridging over a thin foreground
    // ledge. Use the active projection, including a reflector's oblique plane.
    const projected = cameraProjectionMatrix.mul(vec4(viewPosition, 1))
    this.material.depthNode = fragmentDepth(projected.z.div(projected.w))
    this.mesh = new Mesh(
      new PlaneGeometry(2, 2, mobile ? 80 : 128, mobile ? 80 : 128),
      this.material,
    )
    this.mesh.name = 'waterfall-fluid'
    this.mesh.frustumCulled = false
    this.mesh.layers.set(WATERFALL_FLUID_LAYER)
    this.mesh.receiveShadow = true
    this.mesh.renderOrder = 1
    this.mesh.onBeforeRender = (renderer, _scene, camera) => {
      if (!(renderer instanceof WebGPURenderer) || !this.prepared || this.compilationDepth > 0)
        return
      const rendered = this.pass.render(renderer, camera, this.mesh.matrixWorld)
      this.visible.value = rendered ? 1 : 0
      if (rendered) this.updateProjection()
    }
  }

  private updateProjection() {
    this.projectionInverse.value.copy(this.pass.projectionInverse)
    this.localFromView.value.copy(this.mesh.matrixWorld).invert().multiply(this.pass.cameraWorld)
    this.pixel.value.set(1 / this.pass.captureSize.x, 1 / this.pass.captureSize.y)
    this.viewMatrix.copy(this.pass.cameraWorld).invert()
    this.particles.bounds.getCenter(this.center)
    this.center.applyMatrix4(this.mesh.matrixWorld).applyMatrix4(this.viewMatrix)
    this.fallbackDepth.value = Math.max(0.01, -this.center.z)
  }

  setWaterSurface(uniforms: LakeWaterMaterial['uniforms']) {
    const [dx, dz] = this.fall.direction
    const position = this.particles.positionNode
    this.pass.setPositionNode(
      Fn(() => {
        const local = position.toVar()
        const world = vec2(
          local.x.mul(dz).add(local.z.mul(dx)).add(this.fall.x),
          local.z.mul(dz).sub(local.x.mul(dx)).add(this.fall.z),
        )
        const height = windFieldNode(world, float(0), uniforms).x.add(
          uniforms.uState.sample(fieldUvNode(world)).r,
        )
        return local.add(vec3(0, height.mul(smoothstep(0.1, 0.6, local.y).oneMinus()), 0))
      })(),
    )
  }

  async prepare(renderer: WebGPURenderer, camera: Camera) {
    if (this.disposed) return
    this.mesh.updateWorldMatrix(true, false)
    camera.updateMatrixWorld()
    await this.pass.compileAsync(renderer, camera, this.mesh.matrixWorld)
    if (this.disposed) return
    this.prepared = true
    this.updateProjection()
  }

  /** Object callbacks also run during Three's asynchronous compilation. */
  async compile<T>(compile: () => Promise<T>): Promise<T> {
    this.compilationDepth++
    try {
      return await compile()
    } finally {
      this.compilationDepth--
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.prepared = false
    this.visible.value = 0
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.pass.dispose()
    this.particles.geometry.dispose()
  }
}
