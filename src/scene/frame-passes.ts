import { Vector3 } from 'three/webgpu'
import type { DirectionalLight, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu'

import type { DepthFocus } from './depth-focus'
import type { SceneRenderDiagnostics } from './diagnostics'
import type { EnvironmentProbe } from './environment-probe'
import type { LakeReflector } from './lake-water'
import type { LandscapeState } from './landscape-state'
import type { LanternSystem } from './lantern-system'
import type { RainEffect } from './rain-effect'
import type { SceneContrast } from './scene-contrast'
import type { ScenePicker } from './scene-picking'
import type { SubmergedScene } from './submerged-scene'
import type { VolumetricLight } from './volumetric-light'
import type { WaterSimulation } from './water-simulation'

export type PassTargets = Readonly<{
  renderer: WebGPURenderer
  scene: Scene
  camera: PerspectiveCamera
  diagnostics: SceneRenderDiagnostics
  simulation: WaterSimulation
  water: LakeReflector
  rain: RainEffect
  moon: DirectionalLight
  lamps: LanternSystem
  probe: EnvironmentProbe
  submerged: SubmergedScene
  depthFocus: DepthFocus
  atmosphere: VolumetricLight
  sceneContrast: SceneContrast
  picker: ScenePicker
  state: Readonly<LandscapeState>
}>

export type PassFrame = Readonly<{
  now: number
  atmosphereTime: number
  sunDirection: Vector3
  /** Lightning flash, 0–1: the sky reflection refreshes whole while it changes. */
  flash: number
  /** Milliseconds between probe faces. */
  probeInterval: number
  /** 0 by day: the lanterns' cube shadows only follow them at night. */
  nightLightFade: number
}>

/**
 * The frame's GPU passes in their fixed order, each measured for the benchmark: the wave
 * solver, then (after the CPU rain step) the rain slopes, shadow refreshes, the environment
 * probe and sky reflection, the lakebed capture, the main view with the lens, the rain overlay
 * and the profile's contrast mask.
 */
export class FramePasses {
  private readonly targets: PassTargets
  /** Counts presented frames for the lakebed capture's schedule; the first renders it all. */
  private submergedFrame = 0
  private readonly moonShadowDirection = new Vector3(Number.NaN, Number.NaN, Number.NaN)
  private readonly shadowProbe = new Vector3()

  constructor(targets: PassTargets) {
    this.targets = targets
  }

  /** Steps the wave solver (frozen under reduced motion) and binds its newest state. */
  stepWater(dt: number) {
    const { diagnostics, renderer, simulation, water, state } = this.targets
    const renderInfo = renderer.info.render
    if (!state.reducedMotion) {
      const pass = diagnostics.begin('water', renderInfo.calls)
      simulation.step(dt, state.elapsed)
      diagnostics.end(pass, renderInfo.calls)
    }
    water.material.uniforms.uState.value = simulation.texture
  }

  render(frame: PassFrame) {
    const { renderer, scene, camera, diagnostics, rain, probe, submerged, depthFocus, state } =
      this.targets
    const renderInfo = renderer.info.render
    // The frame presents on the canvas. A resumed `compileAsync` re-binds the target it captured
    // (the mirror's, after the scene compile), and each pass below restores what it found: without
    // this, the first frame's lens drew into that target. Motion hid it, as the loader's next
    // animation frame re-bound the canvas; under reduced motion the loader stayed on screen.
    renderer.setRenderTarget(null)
    const slopes = diagnostics.begin('rainSlopes', renderInfo.calls)
    rain.renderSlopes(renderer, camera, state.elapsed)
    diagnostics.end(slopes, renderInfo.calls)
    this.updateShadows(frame.nightLightFade)
    const environment = diagnostics.begin('environment', renderInfo.calls)
    probe.update(frame.now, frame.atmosphereTime, frame.probeInterval)
    probe.captureSky(frame.sunDirection, frame.flash)
    diagnostics.end(environment, renderInfo.calls)
    const bedPass = diagnostics.begin('submerged', renderInfo.calls)
    // The atlas persists between refreshes: fish move every other frame (30 Hz), the bed only
    // sways its seagrass and moves its caustics, so it refreshes on every other fish frame
    // (15 Hz), and on every one while the intro's time-lapse sweeps its light. A bed refresh
    // clears the whole atlas and redraws the fish, so it only ever lands on a fish frame: the
    // fish keep an even cadence.
    const capture = ++this.submergedFrame
    const fish = state.reducedMotion || capture % 2 === 1
    const bed = state.reducedMotion || (fish && (state.intro < 1 || capture % 4 === 1))
    if (fish) submerged.render(renderer, scene, camera, bed)
    diagnostics.end(bedPass, renderInfo.calls)
    const main = diagnostics.begin('main', renderInfo.calls)
    const { atmosphere } = this.targets
    depthFocus.render(renderer, scene, camera, atmosphere, this.targets.moon, this.targets.water)
    diagnostics.end(main, renderInfo.calls)
    const overlay = diagnostics.begin('rainOverlay', renderInfo.calls)
    rain.renderOverlay(renderer, scene, camera, depthFocus.depthTexture)
    diagnostics.end(overlay, renderInfo.calls)
    const contrast = diagnostics.begin('contrast', renderInfo.calls)
    this.targets.sceneContrast.render(
      renderer,
      atmosphere.target.texture,
      this.targets.picker.bounds,
    )
    diagnostics.end(contrast, renderInfo.calls)
  }

  /** Shadow casters (layer 5) are static terrain, so maps only follow light motion. */
  private updateShadows(nightLightFade: number) {
    const { moon, lamps } = this.targets
    const direction = this.shadowProbe.copy(moon.position).sub(moon.target.position).normalize()
    // 5e-4 rad moves the far shadow edge by about half a 2048² texel.
    if (!(direction.dot(this.moonShadowDirection) > 1 - 1.25e-7)) {
      moon.shadow.needsUpdate = true
      this.moonShadowDirection.copy(direction)
    }
    if (nightLightFade === 0 || !lamps.lamps.length) return
    lamps.updateShadows()
  }
}
