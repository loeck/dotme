import {
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  RedFormat,
  DepthTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Matrix4,
  PlaneGeometry,
  UnsignedIntType,
  WebGLRenderTarget,
  Vector4,
  Float32BufferAttribute,
} from 'three'
import type { Scene, WebGLRenderer } from 'three'

import { LAKE_BOUNDS, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'

/** Layer 1 contains only the lit bed. The main and mirror cameras use layer 0. */
export class SubmergedScene {
  /** Material hooks are installed by the engine after shared light/shadow hooks. */
  get surfaceMaterials(): readonly MeshStandardMaterial[] {
    return [this.material]
  }

  readonly target = new WebGLRenderTarget(1, 1, {
    depthTexture: new DepthTexture(1, 1, UnsignedIntType),
    stencilBuffer: false,
  })
  readonly depthField: DataTexture
  readonly fieldLayout: Vector4
  readonly viewProjection = new Matrix4()
  readonly inverseViewProjection = new Matrix4()
  // Spend the existing capture pixels on the visible near lake. The full 160m
  // simulation domain made fish narrower than two texels even on desktop.
  private readonly camera = new OrthographicCamera(-28, 28, 28, -28, 0.1, 80)
  private readonly group = new Group()
  private readonly geometry: PlaneGeometry
  private readonly material = new MeshStandardMaterial({
    color: 0x718080,
    roughness: 0.96,
    vertexColors: true,
  })

  constructor(scene: Scene, bed: LakeBed, floatColor: boolean) {
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
    const shoreSize = Math.sqrt(bed.shore.length)
    const atlasHeight = n + shoreSize
    const data = new Uint16Array(shoreSize * atlasHeight)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++)
        data[y * shoreSize + x] = DataUtils.toHalfFloat(bed.depth[y * n + x]!)
    }
    for (let i = 0; i < bed.shore.length; i++)
      data[n * shoreSize + i] = DataUtils.toHalfFloat(bed.shore[i]!)
    this.depthField = new DataTexture(data, shoreSize, atlasHeight, RedFormat, HalfFloatType)
    this.depthField.minFilter = this.depthField.magFilter = LinearFilter
    this.depthField.needsUpdate = true
    this.fieldLayout = new Vector4(n / shoreSize, n / atlasHeight, 1 / shoreSize, 1 / atlasHeight)
    this.geometry = new PlaneGeometry(LAKE_BOUNDS.size, LAKE_BOUNDS.size, n - 1, n - 1)
    const positions = this.geometry.attributes.position!
    const colors = new Float32Array(n * n * 3)
    for (let i = 0; i < positions.count; i++) {
      const x = i % n,
        z = Math.floor(i / n)
      positions.setXYZ(
        i,
        LAKE_BOUNDS.minX + ((x + 0.5) * LAKE_BOUNDS.size) / n,
        WATER_LEVEL - Math.max(0.04, bed.depth[i]!),
        LAKE_BOUNDS.minZ + ((z + 0.5) * LAKE_BOUNDS.size) / n,
      )
      // Low-frequency world-space variation stays independent of grid
      // resolution; alternating vertex colors formed a visible striped mesh.
      const worldX = positions.getX(i),
        worldZ = positions.getZ(i)
      const shade =
        0.76 +
        0.055 * Math.sin(worldX * 0.71 + Math.sin(worldZ * 0.43)) +
        0.035 * Math.sin(worldZ * 0.93 - worldX * 0.37)
      colors.set([shade, shade * 0.93, shade * 0.81], i * 3)
    }
    // Rows grow toward positive world z, keeping the triangles upward-facing.
    this.geometry.computeVertexNormals()
    this.geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
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

  resize(mobile: boolean) {
    const size = mobile ? 512 : 1024
    this.target.setSize(size, size)
  }

  render(renderer: WebGLRenderer, scene: Scene) {
    const previous = renderer.getRenderTarget()
    const background = scene.background,
      fog = scene.fog
    try {
      scene.background = new Color(0x080c11)
      scene.fog = null
      renderer.setRenderTarget(this.target)
      renderer.render(scene, this.camera)
    } finally {
      scene.background = background
      scene.fog = fog
      renderer.setRenderTarget(previous)
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
