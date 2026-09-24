import {
  Color,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  RedFormat,
  DepthTexture,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Matrix4,
  BufferGeometry,
  BufferAttribute,
  Box3,
  Sphere,
  Vector3,
  UnsignedIntType,
  RenderTarget,
  Vector4,
  Vector2,
} from 'three/webgpu'
import type { Scene, WebGPURenderer } from 'three/webgpu'

import type { LakeBed } from './lake-bed'
import type { PreparedSubmergedSurface } from './lake-geometry-data'

/** Layer 1 contains only the lit bed. The main and mirror cameras use layer 0. */
export class SubmergedScene {
  /** Material hooks are installed by the engine after shared light/shadow hooks. */
  get surfaceMaterials(): readonly MeshStandardNodeMaterial[] {
    return [this.material]
  }

  readonly target = new RenderTarget(1, 1, {
    depthTexture: new DepthTexture(1, 1, UnsignedIntType),
    stencilBuffer: false,
  })
  readonly depthField: DataTexture
  readonly fieldLayout: Vector4
  readonly viewProjection = new Matrix4()
  readonly inverseViewProjection = new Matrix4()
  readonly atlasLayout = new Vector4()
  readonly fishInverseViewProjection = new Matrix4()
  readonly bedTexel = new Vector2()
  private readonly fishCamera = new PerspectiveCamera()
  private bedSize = 1
  private fishWidth = 1
  private fishHeight = 1
  // Spend the existing capture pixels on the visible near lake. The full 160m
  // simulation domain made fish narrower than two texels even on desktop.
  private readonly camera = new OrthographicCamera(-28, 28, 28, -28, 0.1, 80)
  private readonly group = new Group()
  private readonly geometry: BufferGeometry
  private readonly material = new MeshStandardNodeMaterial({
    color: 0xb4b59e,
    roughness: 0.96,
    vertexColors: true,
    fog: false,
  })

  constructor(scene: Scene, bed: LakeBed, floatColor: boolean, prepared: PreparedSubmergedSurface) {
    // A steep oblique capture approximates the refracted viewing direction.
    // Unlike a zenith view, it preserves fish flanks and vertical caudal fins;
    // unlike the grazing main camera, it can still see the shallow lake bed.
    this.camera.position.set(0, 30, 16)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(0, 0, -14)
    this.camera.layers.set(1)
    this.camera.updateMatrixWorld()
    this.viewProjection.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    )
    this.inverseViewProjection.copy(this.viewProjection).invert()
    if (floatColor) this.target.texture.type = HalfFloatType
    const n = bed.resolution
    // One red-channel atlas retains both native grids without resampling. This
    // leaves a fragment sampler for rain even with the maximum lamp shadow count.
    const { atlas, atlasWidth, atlasHeight, geometry, colors, bounds } = prepared
    this.depthField = new DataTexture(atlas, atlasWidth, atlasHeight, RedFormat, HalfFloatType)
    this.depthField.minFilter = this.depthField.magFilter = LinearFilter
    this.depthField.needsUpdate = true
    this.fieldLayout = new Vector4(n / atlasWidth, n / atlasHeight, 1 / atlasWidth, 1 / atlasHeight)
    this.geometry = new BufferGeometry()
    this.geometry.setAttribute('position', new BufferAttribute(geometry.positions, 3))
    this.geometry.setAttribute('normal', new BufferAttribute(geometry.normals, 3))
    this.geometry.setAttribute('uv', new BufferAttribute(geometry.uv, 2))
    this.geometry.setAttribute('color', new BufferAttribute(colors, 3))
    this.geometry.setIndex(new BufferAttribute(geometry.indices, 1))
    this.geometry.boundingBox = new Box3(new Vector3(...bounds.min), new Vector3(...bounds.max))
    this.geometry.boundingSphere = new Sphere(new Vector3(...bounds.center), bounds.radius)
    const floor = new Mesh(this.geometry, this.material)
    floor.receiveShadow = true
    this.group.add(floor)
    this.group.traverse((object) => {
      object.layers.set(1)
      object.updateMatrixWorld(true)
      object.matrixAutoUpdate = object.matrixWorldAutoUpdate = false
    })
    scene.add(this.group)
  }

  resize(mobile: boolean, width = 1280, height = 720) {
    this.bedSize = mobile ? 512 : 1024
    const scale = Math.min(1, (mobile ? 960 : 1600) / width)
    this.fishWidth = Math.max(1, Math.round(width * scale))
    this.fishHeight = Math.max(1, Math.round(height * scale))
    const atlasWidth = Math.max(this.bedSize, this.fishWidth)
    const atlasHeight = this.bedSize + this.fishHeight
    this.target.setSize(atlasWidth, atlasHeight)
    this.target.scissorTest = true
    this.atlasLayout.set(
      this.bedSize / atlasWidth,
      this.bedSize / atlasHeight,
      this.fishWidth / atlasWidth,
      this.fishHeight / atlasHeight,
    )
    this.bedTexel.set(1 / this.bedSize, 1 / this.bedSize)
  }

  async compileAsync(renderer: WebGPURenderer, scene: Scene, mainCamera: PerspectiveCamera) {
    this.fishCamera.copy(mainCamera)
    this.fishCamera.layers.set(3)
    const compileCapture = (camera: OrthographicCamera | PerspectiveCamera) => {
      const previous = renderer.getRenderTarget()
      const background = scene.background
      let compiled: Promise<void>
      try {
        scene.background = null
        renderer.setRenderTarget(this.target)
        compiled = renderer.compileAsync(scene, camera)
      } finally {
        scene.background = background
        renderer.setRenderTarget(previous)
      }
      return compiled
    }
    await compileCapture(this.camera)
    this.viewProjection.multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    )
    this.inverseViewProjection.copy(this.viewProjection).invert()
    await compileCapture(this.fishCamera)
  }

  render(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera) {
    if (this.camera.coordinateSystem !== renderer.coordinateSystem) {
      this.camera.coordinateSystem = renderer.coordinateSystem
      this.camera.updateProjectionMatrix()
      this.viewProjection.multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      )
      this.inverseViewProjection.copy(this.viewProjection).invert()
    }
    const previous = renderer.getRenderTarget()
    const background = scene.background
    const clearColor = renderer.getClearColor(new Color())
    const clearAlpha = renderer.getClearAlpha()
    const viewport = renderer.getViewport(new Vector4())
    const scissor = renderer.getScissor(new Vector4())
    const scissorTest = renderer.getScissorTest()
    const autoClear = renderer.autoClear
    try {
      // Attachment clears cover the entire texture on WebGPU, independent of
      // the scissor. Clear the atlas once, then preserve both capture regions.
      renderer.setScissorTest(false)
      this.target.viewport.set(0, 0, this.target.width, this.target.height)
      this.target.scissor.copy(this.target.viewport)
      renderer.setRenderTarget(this.target)
      renderer.setClearColor(0, 0)
      renderer.clear()
      renderer.autoClear = false
      renderer.setScissorTest(true)
      scene.background = null
      // Render-target regions use device pixels. Renderer.setViewport would
      // multiply by DPR again and move the fish region off-atlas on mobile.
      this.target.viewport.set(0, 0, this.bedSize, this.bedSize)
      this.target.scissor.copy(this.target.viewport)
      renderer.setRenderTarget(this.target)
      renderer.render(scene, this.camera)
      this.fishCamera.copy(camera)
      this.fishCamera.coordinateSystem = renderer.coordinateSystem
      this.fishCamera.updateProjectionMatrix()
      this.fishCamera.layers.set(3)
      this.fishCamera.updateMatrixWorld()
      this.fishInverseViewProjection.multiplyMatrices(
        this.fishCamera.matrixWorld,
        this.fishCamera.projectionMatrixInverse,
      )
      scene.background = null
      renderer.setClearColor(0, 0)
      this.target.viewport.set(0, this.bedSize, this.fishWidth, this.fishHeight)
      this.target.scissor.copy(this.target.viewport)
      renderer.setRenderTarget(this.target)
      renderer.render(scene, this.fishCamera)
    } finally {
      renderer.autoClear = autoClear
      scene.background = background
      renderer.setClearColor(clearColor, clearAlpha)
      renderer.setRenderTarget(previous)
      renderer.setViewport(viewport)
      renderer.setScissor(scissor)
      renderer.setScissorTest(scissorTest)
    }
  }

  dispose() {
    this.group.removeFromParent()
    this.target.dispose()
    this.depthField.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}
