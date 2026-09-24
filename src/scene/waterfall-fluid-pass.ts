import { float, Fn, positionView, texture, uniform, uv, vec2, vec4 } from 'three/tsl'
import {
  AdditiveBlending,
  Camera,
  Color,
  FloatType,
  HalfFloatType,
  LinearSRGBColorSpace,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  NoToneMapping,
  RenderTarget,
  Scene,
  Vector2,
  Vector4,
  WebGPUCoordinateSystem,
} from 'three/webgpu'
import type { Box3, InstancedBufferGeometry, Node, WebGPURenderer } from 'three/webgpu'

import { FullscreenPass } from './fullscreen-pass'

export interface WaterfallFluidParticles {
  readonly geometry: InstancedBufferGeometry
  /** Complete vertex position, including the particle radius, in waterfall space. */
  readonly positionNode: Node<'vec3'>
  /** Optical path through the particle's actual shape. */
  readonly chordNode: Node<'float'>
  readonly aerationNode: Node<'float'>
  readonly bounds: Box3
}

/** Particle depth and optical thickness, restricted to the waterfall's screen bounds. */
export class WaterfallFluidPass {
  /** Linear camera depth in R; zero means empty. */
  readonly depthTexture
  /** Integrated chord length in R, aerated chord length in G. */
  readonly thicknessTexture
  readonly projectionInverse = new Matrix4()
  readonly cameraWorld = new Matrix4()
  /** Top-left texture origin and size relative to the original camera image. */
  readonly uvRect = new Vector4(0, 0, 1, 1)
  readonly captureSize = new Vector2(1, 1)
  private readonly camera = new Camera()
  private readonly depthScene = new Scene()
  private readonly thicknessScene = new Scene()
  private readonly depthMaterial = new MeshBasicNodeMaterial({
    toneMapped: false,
    fog: false,
  })
  private readonly thicknessMaterial = new MeshBasicNodeMaterial({
    toneMapped: false,
    fog: false,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  private readonly depthMesh: Mesh
  private readonly thicknessMesh: Mesh
  private readonly rawDepth = this.target(FloatType, true)
  private readonly rawThickness = this.target(HalfFloatType)
  private readonly horizontalDepth = this.target(FloatType)
  private readonly horizontalThickness = this.target(HalfFloatType)
  private readonly finalDepth = this.target(FloatType)
  private readonly finalThickness = this.target(HalfFloatType)
  private readonly texel = uniform(new Vector2(1, 1))
  private passes:
    | readonly [FullscreenPass, FullscreenPass, FullscreenPass, FullscreenPass]
    | undefined
  private readonly particles: WaterfallFluidParticles
  private readonly crop = new Matrix4()
  private readonly viewProjection = new Matrix4()
  private readonly projected = new Vector4()
  private readonly targets: readonly RenderTarget[]
  private disposed = false

  constructor(particles: WaterfallFluidParticles, mobile: boolean) {
    this.particles = particles
    this.depthTexture = this.finalDepth.texture
    this.thicknessTexture = this.finalThickness.texture
    this.targets = [
      this.rawDepth,
      this.rawThickness,
      this.horizontalDepth,
      this.horizontalThickness,
      this.finalDepth,
      this.finalThickness,
    ]
    // A fixed allocation survives camera motion, reflections and cube-map views.
    // The cropped projection, not the texture aspect, defines the world-space rays.
    const resolution = mobile ? 128 : 192
    this.captureSize.set(resolution, resolution)
    this.texel.value.set(1 / resolution, 1 / resolution)
    for (const renderTarget of this.targets) renderTarget.setSize(resolution, resolution)
    this.depthMaterial.positionNode = particles.positionNode
    this.depthMaterial.fragmentNode = vec4(positionView.z.negate(), 0, 0, 1)
    this.thicknessMaterial.positionNode = particles.positionNode
    const chord = particles.chordNode
    this.thicknessMaterial.fragmentNode = vec4(chord, chord.mul(particles.aerationNode), 0, 1)
    this.depthMesh = new Mesh(particles.geometry, this.depthMaterial)
    this.thicknessMesh = new Mesh(particles.geometry, this.thicknessMaterial)
    for (const mesh of [this.depthMesh, this.thicknessMesh]) {
      mesh.frustumCulled = false
      mesh.matrixAutoUpdate = false
      mesh.matrixWorldAutoUpdate = false
    }
    this.camera.matrixAutoUpdate = false
    this.camera.matrixWorldAutoUpdate = false
    this.depthScene.add(this.depthMesh)
    this.thicknessScene.add(this.thicknessMesh)
  }

  private ensurePasses(renderer: WebGPURenderer) {
    this.passes ??= [
      new FullscreenPass(renderer, this.filter(this.rawDepth, this.rawDepth, true, true)),
      new FullscreenPass(renderer, this.filter(this.rawThickness, this.rawDepth, true, false)),
      new FullscreenPass(
        renderer,
        this.filter(this.horizontalDepth, this.horizontalDepth, false, true),
      ),
      new FullscreenPass(
        renderer,
        this.filter(this.horizontalThickness, this.horizontalDepth, false, false),
      ),
    ]
    return this.passes
  }

  setPositionNode(node: Node<'vec3'>): void {
    this.depthMaterial.positionNode = node
    this.thicknessMaterial.positionNode = node
    this.depthMaterial.needsUpdate = true
    this.thicknessMaterial.needsUpdate = true
  }

  private target(type: typeof FloatType | typeof HalfFloatType, depthBuffer = false) {
    return new RenderTarget(1, 1, {
      type,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer,
      stencilBuffer: false,
    })
  }

  /** A small separable bilateral approximation, not a narrow-range reconstruction. */
  private filter(source: RenderTarget, depth: RenderTarget, horizontal: boolean, isDepth: boolean) {
    const sourceNode = texture(source.texture)
    const depthNode = texture(depth.texture)
    return Fn(() => {
      const point = uv()
      const centerDepth = depthNode.sample(point).r
      const total = vec2(0).toVar()
      const weights = float(0).toVar()
      const direction = horizontal ? vec2(this.texel.x, 0) : vec2(0, this.texel.y)
      // World-space threshold limits blending between physically separate streams.
      const range = float(0.15)
      const offsets = isDepth ? [-4, -3, -2, -1, 0, 1, 2, 3, 4] : [-2, -1, 0, 1, 2]
      for (const offset of offsets) {
        const sampleUv = point.add(direction.mul(offset))
        const neighbourDepth = depthNode.sample(sampleUv).r
        const difference = neighbourDepth.sub(centerDepth).div(range)
        const spatial = isDepth
          ? Math.exp(-(offset * offset) / (2 * 2.2 * 2.2))
          : offset === 0
            ? 6
            : Math.abs(offset) === 1
              ? 4
              : 1
        const bilateral = difference.mul(difference).negate().exp().mul(spatial)
        const valid = neighbourDepth
          .greaterThan(0)
          .and(centerDepth.greaterThan(0))
          .and(difference.abs().lessThanEqual(1))
        const weight = isDepth ? valid.select(bilateral, 0) : float(spatial)
        total.addAssign(sourceNode.sample(sampleUv).rg.mul(weight))
        weights.addAssign(weight)
      }
      const result = total.div(weights.max(0.00001))
      return vec4(isDepth ? centerDepth.greaterThan(0).select(result, vec2(0)) : result, 0, 1)
    })()
  }

  /** Update the crop and reconstruction matrices without rendering. */
  updateCamera(camera: Camera, parentMatrixWorld: Matrix4): boolean {
    if (this.disposed) return false
    this.camera.coordinateSystem = camera.coordinateSystem
    this.camera.matrix.copy(camera.matrixWorld)
    this.camera.matrixWorld.copy(camera.matrixWorld)
    this.camera.matrixWorldInverse.copy(camera.matrixWorldInverse)
    this.cameraWorld.copy(camera.matrixWorld)
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.viewProjection.multiply(parentMatrixWorld)
    const { min, max } = this.particles.bounds
    let left = Infinity,
      bottom = Infinity,
      right = -Infinity,
      top = -Infinity,
      behind = 0
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) {
          this.projected.set(x, y, z, 1).applyMatrix4(this.viewProjection)
          if (this.projected.w <= 0.0001) {
            behind++
            continue
          }
          const px = this.projected.x / this.projected.w
          const py = this.projected.y / this.projected.w
          left = Math.min(left, px)
          right = Math.max(right, px)
          bottom = Math.min(bottom, py)
          top = Math.max(top, py)
        }
      }
    }
    if (behind === 8) return false
    if (behind > 0) {
      left = bottom = -1
      right = top = 1
    }
    const padX = Math.max(0.004, (right - left) * 0.04)
    const padY = Math.max(0.004, (top - bottom) * 0.04)
    left = Math.max(-1, left - padX)
    right = Math.min(1, right + padX)
    bottom = Math.max(-1, bottom - padY)
    top = Math.min(1, top + padY)
    if (right <= left || top <= bottom) return false
    const width = right - left,
      height = top - bottom
    this.uvRect.set((left + 1) / 2, (1 - top) / 2, width / 2, height / 2)
    this.crop.set(
      2 / width,
      0,
      0,
      -(right + left) / width,
      0,
      2 / height,
      0,
      -(top + bottom) / height,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
    )
    this.camera.projectionMatrix.multiplyMatrices(this.crop, camera.projectionMatrix)
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert()
    this.projectionInverse.copy(this.camera.projectionMatrixInverse)
    for (const mesh of [this.depthMesh, this.thicknessMesh]) {
      mesh.matrix.copy(parentMatrixWorld)
      mesh.matrixWorld.copy(parentMatrixWorld)
    }
    return true
  }

  private prepare(renderer: WebGPURenderer, camera: Camera, parentMatrixWorld: Matrix4) {
    if (!this.updateCamera(camera, parentMatrixWorld)) return false
    if (this.camera.coordinateSystem !== renderer.coordinateSystem) {
      // Adapt clip Z without asking a generic camera to rebuild the oblique projection.
      const webgpu = renderer.coordinateSystem === WebGPUCoordinateSystem
      this.crop.set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, webgpu ? 0.5 : 2, webgpu ? 0.5 : -1, 0, 0, 0, 1)
      this.camera.projectionMatrix.premultiply(this.crop)
      this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert()
      this.projectionInverse.copy(this.camera.projectionMatrixInverse)
      this.camera.coordinateSystem = renderer.coordinateSystem
    }
    return true
  }

  private withState<T>(renderer: WebGPURenderer, action: () => T): T {
    const target = renderer.getRenderTarget()
    const face = renderer.getActiveCubeFace(),
      mip = renderer.getActiveMipmapLevel(),
      autoClear = renderer.autoClear,
      toneMapping = renderer.toneMapping,
      outputColorSpace = renderer.outputColorSpace,
      xr = renderer.xr.enabled,
      mrt = renderer.getMRT(),
      renderObject = renderer.getRenderObjectFunction()
    const clearColor = renderer.getClearColor(new Color())
    const clearAlpha = renderer.getClearAlpha()
    const viewport = renderer.getViewport(new Vector4())
    const scissor = renderer.getScissor(new Vector4())
    const scissorTest = renderer.getScissorTest()
    try {
      renderer.setMRT(null)
      renderer.setRenderObjectFunction(null)
      renderer.autoClear = true
      renderer.toneMapping = NoToneMapping
      renderer.outputColorSpace = LinearSRGBColorSpace
      renderer.xr.enabled = false
      renderer.setScissorTest(false)
      renderer.setClearColor(0, 0)
      return action()
    } finally {
      renderer.setMRT(mrt)
      renderer.setRenderObjectFunction(renderObject)
      renderer.autoClear = autoClear
      renderer.toneMapping = toneMapping
      renderer.outputColorSpace = outputColorSpace
      renderer.xr.enabled = xr
      renderer.setClearColor(clearColor, clearAlpha)
      renderer.setRenderTarget(target, face, mip)
      renderer.setViewport(viewport)
      renderer.setScissor(scissor)
      renderer.setScissorTest(scissorTest)
    }
  }

  async compileAsync(
    renderer: WebGPURenderer,
    camera: Camera,
    parentMatrixWorld: Matrix4,
  ): Promise<void> {
    if (this.disposed || !this.prepare(renderer, camera, parentMatrixWorld)) return
    const [horizontalDepth, horizontalThickness, verticalDepth, verticalThickness] =
      this.ensurePasses(renderer)
    await this.withState(renderer, () => {
      renderer.setRenderTarget(this.rawDepth)
      return renderer.compileAsync(this.depthScene, this.camera)
    })
    if (this.disposed) return
    await this.withState(renderer, () => {
      renderer.setRenderTarget(this.rawThickness)
      return renderer.compileAsync(this.thicknessScene, this.camera)
    })
    if (this.disposed) return
    await this.withState(renderer, () => horizontalDepth.compileAsync(this.horizontalDepth))
    if (this.disposed) return
    await this.withState(renderer, () => horizontalThickness.compileAsync(this.horizontalThickness))
    if (this.disposed) return
    await this.withState(renderer, () => verticalDepth.compileAsync(this.finalDepth))
    if (this.disposed) return
    await this.withState(renderer, () => verticalThickness.compileAsync(this.finalThickness))
  }

  render(renderer: WebGPURenderer, camera: Camera, parentMatrixWorld: Matrix4): boolean {
    if (this.disposed || !this.prepare(renderer, camera, parentMatrixWorld)) return false
    const [horizontalDepth, horizontalThickness, verticalDepth, verticalThickness] =
      this.ensurePasses(renderer)
    this.withState(renderer, () => {
      renderer.setRenderTarget(this.rawDepth)
      renderer.render(this.depthScene, this.camera)
      renderer.setRenderTarget(this.rawThickness)
      renderer.render(this.thicknessScene, this.camera)
      renderer.setRenderTarget(this.horizontalDepth)
      horizontalDepth.render()
      renderer.setRenderTarget(this.horizontalThickness)
      horizontalThickness.render()
      renderer.setRenderTarget(this.finalDepth)
      verticalDepth.render()
      renderer.setRenderTarget(this.finalThickness)
      verticalThickness.render()
    })
    return true
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.depthMaterial.dispose()
    this.thicknessMaterial.dispose()
    this.depthScene.clear()
    this.thicknessScene.clear()
    for (const pass of this.passes ?? []) pass.dispose()
    for (const target of this.targets) target.dispose()
  }
}
