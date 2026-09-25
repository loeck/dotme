import { attribute, cos, positionLocal, sin, uniform, vec3 } from 'three/tsl'
import {
  Color,
  DataTexture,
  DodecahedronGeometry,
  DoubleSide,
  Euler,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  RedFormat,
  DepthTexture,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Matrix4,
  PlaneGeometry,
  BufferGeometry,
  BufferAttribute,
  Box3,
  Sphere,
  Vector3,
  Quaternion,
  UnsignedIntType,
  RenderTarget,
  Vector4,
  Vector2,
} from 'three/webgpu'
import type { Scene, WebGPURenderer } from 'three/webgpu'

import type { LakeBed } from './lake-bed'
import type { PreparedSubmergedSurface } from './lake-geometry-data'
import { placeHeroRocks, placeSeabedRocks, placeSeagrass } from './lake-seabed'

/** Layer 1 contains only the lit bed. The main and mirror cameras use layer 0. */
export class SubmergedScene {
  /** Material hooks are installed by the engine after shared light/shadow hooks. */
  get surfaceMaterials(): readonly MeshStandardNodeMaterial[] {
    return this.hookedMaterials
  }

  get sandMaterial(): MeshStandardNodeMaterial {
    return this.material
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
    color: 0xf0e6cc,
    roughness: 0.96,
    vertexColors: true,
    fog: false,
  })
  private readonly hookedMaterials: MeshStandardNodeMaterial[] = [this.material]
  private readonly rockMaterial = new MeshStandardNodeMaterial({
    color: 0x5b6569,
    roughness: 0.93,
    fog: false,
  })
  private readonly grassMaterial = new MeshStandardNodeMaterial({
    color: 0x46a046,
    roughness: 0.8,
    vertexColors: true,
    side: DoubleSide,
    fog: false,
    emissive: 0x123013,
  })
  private readonly grassTime = uniform(0)
  private rockMesh: InstancedMesh | undefined
  private grassMesh: InstancedMesh | undefined

  constructor(
    scene: Scene,
    bed: LakeBed,
    floatColor: boolean,
    prepared: PreparedSubmergedSurface,
    seed: number,
  ) {
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
    this.buildRocks(bed, seed)
    this.buildGrass(bed, seed)
    this.group.traverse((object) => {
      object.layers.set(1)
      object.updateMatrixWorld(true)
      object.matrixAutoUpdate = object.matrixWorldAutoUpdate = false
    })
    scene.add(this.group)
  }

  private buildRocks(bed: LakeBed, seed: number) {
    const rocks = [...placeHeroRocks(bed, seed), ...placeSeabedRocks(bed, seed)]
    if (!rocks.length) return
    const mesh = new InstancedMesh(
      new DodecahedronGeometry(0.5, 0),
      this.rockMaterial,
      rocks.length,
    )
    const matrix = new Matrix4()
    const rotation = new Quaternion()
    const euler = new Euler()
    const position = new Vector3()
    const scale = new Vector3()
    for (const [index, rock] of rocks.entries()) {
      rotation.setFromEuler(euler.set(0, rock.rotY, 0))
      matrix.compose(
        position.set(rock.x, rock.y, rock.z),
        rotation,
        scale.set(rock.scale, rock.scale * rock.squash, rock.scale),
      )
      mesh.setMatrixAt(index, matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    mesh.receiveShadow = true
    this.group.add(mesh)
    this.rockMesh = mesh
    this.hookedMaterials.push(this.rockMaterial)
  }

  private buildGrass(bed: LakeBed, seed: number) {
    const blades = placeSeagrass(bed, seed)
    if (!blades.length) return
    const geometry = new PlaneGeometry(0.1, 1, 1, 4)
    geometry.translate(0, 0.5, 0)
    const positions = geometry.getAttribute('position')
    const colors = new Float32Array(positions.count * 3)
    for (let i = 0; i < positions.count; i++) {
      const y = positions.getY(i)
      positions.setX(i, positions.getX(i) * (1 - y * 0.7))
      const tone = 0.55 + y * 0.5
      colors.set([tone, tone, tone], i * 3)
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3))
    const phases = new Float32Array(blades.length)
    const mesh = new InstancedMesh(geometry, this.grassMaterial, blades.length)
    const matrix = new Matrix4()
    const rotation = new Quaternion()
    const euler = new Euler()
    const position = new Vector3()
    const scale = new Vector3()
    for (const [index, blade] of blades.entries()) {
      rotation.setFromEuler(euler.set(blade.tilt, blade.rotY, 0))
      matrix.compose(
        position.set(blade.x, blade.y, blade.z),
        rotation,
        scale.set(1, blade.height, 1),
      )
      mesh.setMatrixAt(index, matrix)
      phases[index] = blade.phase
    }
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    mesh.receiveShadow = true
    geometry.setAttribute('aBladePhase', new InstancedBufferAttribute(phases, 1))
    const bend = positionLocal.y.pow(2)
    const sway = attribute('aBladePhase', 'float')
    this.grassMaterial.positionNode = positionLocal.add(
      vec3(
        sin(this.grassTime.mul(1.5).add(sway)).mul(bend).mul(0.09),
        0,
        cos(this.grassTime.mul(1.1).add(sway.mul(1.7)))
          .mul(bend)
          .mul(0.06),
      ),
    )
    this.group.add(mesh)
    this.grassMesh = mesh
    this.hookedMaterials.push(this.grassMaterial)
  }

  update(elapsed: number) {
    this.grassTime.value = elapsed
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
    this.rockMesh?.geometry.dispose()
    this.grassMesh?.geometry.dispose()
    this.rockMaterial.dispose()
    this.grassMaterial.dispose()
  }
}
