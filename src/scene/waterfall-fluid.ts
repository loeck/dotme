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
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  Color,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu'
import type { Camera, Node } from 'three/webgpu'

import { fragmentDepth, screenLinearVarying } from './backend-nodes'
import { WATER_LEVEL } from './lake-bed'
import type { LakeWaterMaterial } from './lake-water'
import type { VoxelWaterfall } from './voxel-world'
import { contactNoise } from './water-noise'
import { fieldUvNode, windFieldNode } from './water-surface'
import { WaterfallFluidPass } from './waterfall-fluid-pass'
import { createWaterfallParticles } from './waterfall-particles'

const GRAVITY = 9.81

/** Henyey-Greenstein phase for the cosine between light travel and the view ray. */
export function scatterPhase(cosine: Node<'float'>, g: number) {
  const denominator = cosine.mul(-2 * g).add(1 + g * g)
  return denominator
    .mul(denominator.sqrt())
    .reciprocal()
    .mul((1 - g * g) / (4 * Math.PI))
}

/** Main and reflected views include the fluid; environment probes avoid self-refraction. */
export const WATERFALL_FLUID_LAYER = 6

/** Reconstructs a lit water surface from particle depth and optical thickness. */
export class WaterfallFluid {
  /**
   * Blended rather than transmissive: transmission would copy and mip the whole
   * framebuffer every frame for a fall a few dozen pixels wide.
   */
  readonly material = new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.12,
    metalness: 0,
    // The sky is most of what a fall shows away from the sun: wet water and
    // foam both carry its reflection.
    envMapIntensity: 1.6,
    transparent: true,
    depthWrite: true,
    alphaTest: 0.015,
    forceSinglePass: true,
  })
  readonly mesh: Mesh<PlaneGeometry, MeshStandardNodeMaterial>
  readonly particles: ReturnType<typeof createWaterfallParticles>
  private readonly pass: WaterfallFluidPass
  private readonly projectionInverse = uniform(new Matrix4())
  private readonly localFromView = uniform(new Matrix4())
  private readonly pixel = uniform(new Vector2(1, 1))
  private readonly visible = uniform(0)
  private readonly fallbackDepth = uniform(25)
  /** Key light (sun or moon) towards the light, and the fall's across axis, in view space. */
  private readonly lightView = uniform(new Vector3(0, 1, 0))
  private readonly lightRadiance = uniform(new Color(0, 0, 0))
  private readonly acrossView = uniform(new Vector3(1, 0, 0))
  private readonly forwardView = uniform(new Vector3(0, 0, 1))
  private readonly lightWorld = new Vector3(0, 1, 0)
  private readonly viewFromLocal = new Matrix4()
  private readonly center = new Vector3()
  private readonly viewMatrix = new Matrix4()
  private readonly fall: VoxelWaterfall
  private compilationDepth = 0
  private prepared = false
  private disposed = false

  constructor(fall: VoxelWaterfall, mobile: boolean, opacity: Node<'float'>, time: Node<'float'>) {
    this.fall = fall
    this.particles = createWaterfallParticles(fall, mobile)
    this.pass = new WaterfallFluidPass(this.particles)
    const sheetHeight = Math.max(0.2, fall.top - WATER_LEVEL)
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
    const vertexLocal = this.localFromView.mul(vec4(vertexView, 1)).xyz
    this.material.positionNode = vertexLocal
    // Raster interpolation must remain linear in screen space as the grid's
    // vertices move to different distances from the camera.
    const point = screenLinearVarying(
      vertexUV,
      cameraProjectionMatrix.mul(vec4(vertexView, 1)).w,
      'waterfallScreenUV',
    )
    const viewPosition = reconstruct(point)
    const data = thickness.sample(point)
    // Overlapping parcel kernels integrate a density estimate: it decides where
    // water is and how thick, while the aerated share comes from the fall itself.
    const opticalThickness = data.r.mul(0.6).clamp(0, 1.5)
    const parcelFoam = data.g.div(data.r.max(0.00001)).clamp(0, 1)
    // Depth is sampled per capture texel; the grid's interpolated position
    // keeps procedural patterns continuous across them.
    const local = varying(vertexLocal, 'waterfallLocal')
    const drop = float(sheetHeight).sub(local.y).max(0)
    // A pattern carried by the water: each feature leaves the lip at one time
    // and reaches `drop` after free-fall time, so it accelerates and stretches.
    const launched = time.sub(drop.mul(2 / GRAVITY).sqrt())
    const across = local.x
    // Lip irregularities fix slowly wandering columns; packets slide within them.
    const columns = contactNoise(vec2(across.mul(7.5), time.mul(0.11)))
    const packets = contactNoise(vec2(across.mul(13), launched.mul(3.2)))
    const grain = contactNoise(vec2(across.mul(31), launched.mul(9)))
    const fibres = contactNoise(vec2(across.mul(24), launched.mul(1.3)).add(5.7))
    // Smooth glassy tongue at the lip, broken into streaks within half a metre,
    // then aerated columns that widen and merge towards the plunge.
    const breakup = smoothstep(0.12, Math.min(1.6, sheetHeight * 0.75), drop)
    const streaks = columns.mul(0.55).add(packets.mul(0.3)).add(grain.mul(0.15))
    const threshold = mix(0.8, 0.4, breakup)
    const aerated = smoothstep(threshold, threshold.add(0.16), streaks).mul(
      smoothstep(0.04, 0.45, drop),
    )
    // Thin fringes along the sheet's edges and gaps fray into white spray.
    const fringe = smoothstep(0.03, 0.3, data.r).oneMinus().mul(breakup)
    const whitewater = aerated
      .mul(mix(0.72, 1, grain))
      .add(fringe.mul(0.55))
      .add(parcelFoam.mul(smoothstep(0.35, 0.9, parcelFoam)))
      .clamp(0, 1)
    // Last Signal's turbid water: a dark olive core that mirrors its sky, and a
    // muted off-white foam rather than a paper-white one.
    const core = mix(vec3(0.045, 0.06, 0.052), vec3(0.09, 0.11, 0.095), smoothstep(0, 1.5, drop))
    const foam = mix(
      vec3(0.52, 0.56, 0.56),
      vec3(0.8, 0.82, 0.81),
      fibres.mul(0.6).add(grain.mul(0.4)),
    )
    this.material.colorNode = mix(core, foam, whitewater)
    this.material.roughnessNode = mix(0.05, 0.38, whitewater)
    this.material.opacityNode = smoothstep(0.004, 0.045, data.r)
      .mul(mix(smoothstep(0, 0.9, opticalThickness).mul(0.3).add(0.62), 0.97, whitewater))
      .mul(depth.sample(point).r.greaterThan(0).select(1, 0))
      .mul(opacity)
      .mul(this.visible)
    // Aerated water scatters the key light forward (Henyey-Greenstein) and the
    // thin core glows a little when backlit, mostly at golden hour.
    const viewDirection = normalize(viewPosition.negate())
    const forward = scatterPhase(viewDirection.dot(this.lightView).negate(), 0.55)
    this.material.emissiveNode = this.lightRadiance
      .mul(forward)
      .mul(mix(vec3(0.03, 0.04, 0.03), vec3(0.32, 0.33, 0.32), whitewater))
    const surfaceNormal = Fn(() => {
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
    // Parcel splats leave a lumpy depth: aerated water takes the sheet's
    // outward normal instead, and fine vertical ridges turn sky highlights into
    // the long glints of a fall.
    const ridges = columns.sub(0.5).mul(0.9).add(packets.sub(0.5).mul(0.5))
    const facing = surfaceNormal.dot(this.forwardView).lessThan(-0.2).select(-1, 1)
    this.material.normalNode = normalize(
      mix(surfaceNormal, this.forwardView.mul(facing), whitewater.mul(0.45).add(0.3)).add(
        this.acrossView.mul(ridges.mul(whitewater.oneMinus().mul(0.45).add(0.15))),
      ),
    )
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
    this.lightView.value.copy(this.lightWorld).transformDirection(this.viewMatrix)
    this.viewFromLocal.multiplyMatrices(this.viewMatrix, this.mesh.matrixWorld)
    this.acrossView.value.set(1, 0, 0).transformDirection(this.viewFromLocal)
    // Tilted skyward: aerated water scatters light from the whole sky, not the bank.
    this.forwardView.value.set(0, 0.75, 1).transformDirection(this.viewFromLocal)
    this.particles.bounds.getCenter(this.center)
    this.center.applyMatrix4(this.mesh.matrixWorld).applyMatrix4(this.viewMatrix)
    this.fallbackDepth.value = Math.max(0.01, -this.center.z)
  }

  /** Direction towards the key light in world space and its colour times intensity. */
  setLight(direction: Vector3, radiance: Color) {
    this.lightWorld.copy(direction).normalize()
    this.lightRadiance.value.copy(radiance)
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
