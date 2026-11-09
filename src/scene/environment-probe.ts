import {
  Camera,
  CubeCamera,
  CubeRenderTarget,
  HalfFloatType,
  PMREMGenerator,
  Vector3,
} from 'three/webgpu'
import type { Scene, WebGPURenderer } from 'three/webgpu'

import { ENVIRONMENT_PROBE } from './camera-rig'
import type { LakeReflector } from './lake-water'
import type { LandscapeState } from './landscape-state'
import type { ResourceScope } from './resource-scope'
import type { SceneDetails } from './scene-details'
import type { createSkyMaterial } from './sky-material'

/** Sky reflection faces in CubeCamera order (+X, -X, +Y, -Y, +Z, -Z). */
const SKY_FACES = [0, 1, 2, 3, 4, 5] as const
/**
 * Between full captures, two faces refresh per frame, each twice every five frames. The lake
 * only reflects the upper hemisphere, so -Y (3) waits for the next full capture.
 */
const SKY_ROUND = [
  [0, 1],
  [2, 4],
  [5, 0],
  [1, 2],
  [4, 5],
] as const

export type ProbeScene = Readonly<{
  renderer: WebGPURenderer
  scene: Scene
  water: LakeReflector
  skyMaterial: ReturnType<typeof createSkyMaterial>
  /** The sky dome alone, for the lake's sky reflection. */
  reflectedSky: Scene
  details: SceneDetails | undefined
  /** Without the GPU water the lit materials keep the unfiltered capture. */
  filtered: boolean
  showSun: boolean
  state: Readonly<LandscapeState>
}>

/**
 * The scene's image-based light and the lake's sky reflection. The live probe renders one cube
 * face per interval and filters the cube (PMREM) once per completed sweep; the sky reflection
 * refreshes two faces a frame. Both mask the sun and moon discs (the lights carry them) and
 * the planar water.
 */
export class EnvironmentProbe {
  readonly target: CubeRenderTarget
  readonly camera: CubeCamera
  private readonly filter: PMREMGenerator
  private filteredTarget: CubeRenderTarget | undefined
  private readonly world: ProbeScene
  private at = -Infinity
  /** The atmosphere clock at the previous update, to tell a clock jump from a slow sweep. */
  private time = -Infinity
  private face = 6
  private skyRound = 0
  private skyFlash = 0
  private readonly skySun = new Vector3()

  /**
   * The cube target, its filter and the cube camera, allocated where the engine always did
   * (before the scene it renders exists); `new EnvironmentProbe` takes them over.
   */
  static allocate(renderer: WebGPURenderer, lowPower: boolean, resources: ResourceScope) {
    // Update once per animation frame; all reflection cameras reuse these shadows.
    const target = resources.own(new CubeRenderTarget(lowPower ? 64 : 256, { type: HalfFloatType }))
    const filter = resources.own(new PMREMGenerator(renderer))
    target.texture.name = 'Live landscape environment'
    const camera = new CubeCamera(0.1, 500, target)
    camera.position.set(ENVIRONMENT_PROBE.x, ENVIRONMENT_PROBE.y, ENVIRONMENT_PROBE.z)
    return { target, filter, camera }
  }

  constructor(world: ProbeScene, parts: ReturnType<typeof EnvironmentProbe.allocate>) {
    this.world = world
    this.target = parts.target
    this.filter = parts.filter
    this.camera = parts.camera
  }

  /** The face camera the compile pass renders the probe's traversal with. */
  get faceCamera() {
    const camera = this.camera.children.find((child) => child instanceof Camera)
    if (!camera) throw new Error('Missing environment cube camera')
    return camera
  }

  /** The next update starts a sweep at once. */
  invalidate() {
    this.at = -Infinity
  }

  /**
   * Establishes the final environment texture before any lit material variant is built; the
   * caller yields a frame between the steps (`frame`).
   */
  async prepare(frame: () => Promise<void>) {
    const { renderer, scene, water } = this.world
    renderer.initRenderTarget(this.target)
    await this.filter.compileCubemapShader()
    await frame()
    this.filteredTarget = this.filter.fromCubemap(this.target.texture)
    scene.environment = this.filteredTarget.texture
    water.material.uniforms.uEnvironment.value = this.filteredTarget.texture
    await frame()
    this.camera.coordinateSystem = renderer.coordinateSystem
    this.camera.updateCoordinateSystem()
    this.camera.updateMatrixWorld()
  }

  /** Every face at once, then the filter: the opening capture. */
  captureAll() {
    this.renderFaces([0, 1, 2, 3, 4, 5])
    this.face = 0
    this.filterEnvironment()
  }

  /**
   * Reuse broad indirect lighting; planar water reflections stay per-frame. Exactly one cube
   * face renders per `interval` ms, so the cost per frame stays flat instead of spiking; a full
   * refresh takes about half a second.
   */
  update(now: number, atmosphereTime: number, interval: number) {
    // A clock jump (time scrub, weather change) restarts the sweep immediately. It is measured
    // from the previous frame, not from the sweep's first face: six faces at the 200 ms
    // low-power interval span just over a second, and measuring from the first face restarted
    // every such sweep before it was filtered, so the lighting stayed stale and then jumped
    // (crowns brightened by about a quarter in one frame) whenever frame timing let one finish.
    const jump = atmosphereTime < this.time || atmosphereTime - this.time > 1
    this.time = atmosphereTime
    if (jump) this.face = 0
    if (!jump && this.world.state.intro === 1 && now - this.at < interval) return
    const face = this.face
    this.at = now

    this.renderFaces([face])
    this.face = (face + 1) % 6
    if (this.face !== 0) return
    this.filterEnvironment()
  }

  /**
   * The lake's sky reflection follows the visible sky: clouds parting under the cursor or a
   * weather change would otherwise wait for the next full probe sweep. Two faces refresh per
   * frame (see SKY_ROUND); all six during the intro, under reduced motion (frames are rare),
   * while lightning flashes, when the sun moves visibly between frames (time-lapse, scrub,
   * clock jumps) and when no `sun` is given. Discs stay out as in the probe; the water lighting
   * model reflects the sun and moon.
   */
  captureSky(sun?: Vector3, flash = 0) {
    const { renderer, water, reflectedSky, skyMaterial, state, showSun } = this.world
    const sharp =
      !sun ||
      state.reducedMotion ||
      state.intro < 1 ||
      flash !== this.skyFlash ||
      sun.dot(this.skySun) < 1 - 1e-5
    if (sun) this.skySun.copy(sun)
    this.skyFlash = flash
    this.skyRound = (this.skyRound + 1) % SKY_ROUND.length
    skyMaterial.uniforms.uShowSun.value = 0
    skyMaterial.uniforms.uShowMoon.value = 0
    try {
      water.captureSky(
        renderer,
        reflectedSky,
        sharp ? SKY_FACES : (SKY_ROUND[this.skyRound] ?? SKY_FACES),
      )
    } finally {
      skyMaterial.uniforms.uShowSun.value = showSun ? 1 : 0
      skyMaterial.uniforms.uShowMoon.value = 1
    }
  }

  /** Renders probe faces with the direct disc and planar water masked out. */
  private renderFaces(faces: readonly number[]) {
    const { scene, water, skyMaterial, showSun } = this.world
    water.visible = false
    const environmentIntensity = scene.environmentIntensity
    scene.environmentIntensity = 0
    // Direct solar energy already comes from the directional light. Excluding the
    // disc from the lighting probe keeps disc visibility independent of illumination.
    skyMaterial.uniforms.uShowSun.value = 0
    skyMaterial.uniforms.uShowMoon.value = 0
    try {
      for (const face of faces) this.renderFace(face)
    } finally {
      water.visible = true
      scene.environmentIntensity = environmentIntensity
      skyMaterial.uniforms.uShowSun.value = showSun ? 1 : 0
      skyMaterial.uniforms.uShowMoon.value = 1
    }
  }

  /** Filter once per completed sweep, before the main render. Lazy filtering
   *  inside a material upload would nest renderer calls and disturb bindings. */
  private filterEnvironment() {
    const { scene, water } = this.world
    if (this.world.filtered) {
      this.filteredTarget = this.filter.fromCubemap(this.target.texture, this.filteredTarget)
      scene.environment = this.filteredTarget.texture
    }
    water.material.uniforms.uEnvironment.value = this.filteredTarget?.texture ?? this.target.texture
  }

  /** CubeCamera.update for one face, so a refresh spreads over six frames. */
  private renderFace(face: number) {
    const { renderer, scene, details } = this.world
    const camera = this.camera
    const target = this.target
    if (camera.parent === null) camera.updateMatrixWorld()
    const faceCamera = camera.children[face]
    if (!(faceCamera instanceof Camera)) throw new Error('Missing environment cube camera')
    const previous = renderer.getRenderTarget(),
      previousFace = renderer.getActiveCubeFace(),
      previousMip = renderer.getActiveMipmapLevel()
    const generateMipmaps = target.texture.generateMipmaps
    // Mipmaps are generated during the render of the final face.
    target.texture.generateMipmaps = face === 5 && generateMipmaps
    try {
      renderer.setRenderTarget(target, face, camera.activeMipmapLevel)
      if (renderer.reversedDepthBuffer && !renderer.autoClear) renderer.clearDepth()
      const render = () => renderer.render(scene, faceCamera)
      // Same object set as the compile pass, so the probe never mints extra variants.
      if (details) details.probeHidden(render)
      else render()
    } finally {
      target.texture.generateMipmaps = generateMipmaps
      renderer.setRenderTarget(previous, previousFace, previousMip)
    }
    if (face === 5) target.texture.needsPMREMUpdate = true
  }

  dispose() {
    this.filteredTarget?.dispose()
  }
}
