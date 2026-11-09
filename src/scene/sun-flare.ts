import { Vector3 } from 'three/webgpu'
import type { PerspectiveCamera } from 'three/webgpu'

import type { DepthFocus } from './depth-focus'
import type { LandscapeState } from './landscape-state'
import { flareStrength } from './lens-flare'
import type { LightingState } from './lighting'
import type { PhysicsWorld } from './physics-world'
import type { ScenePicker } from './scene-picking'

export type FlareWorld = Readonly<{
  camera: PerspectiveCamera
  physics: Pick<PhysicsWorld, 'castDistance'>
  picker: ScenePicker
  depthFocus: DepthFocus
  state: Readonly<LandscapeState>
}>

/** The sun's lens flare: where its disc projects on the frame, and how strongly it flares. */
export class SunFlare {
  private readonly world: FlareWorld
  private readonly point = new Vector3()
  private level = 0

  constructor(world: FlareWorld) {
    this.world = world
  }

  /** `fog` 0–1 veils the disc; `showSun` false hides it. */
  update(light: LightingState, fog: number, showSun: boolean) {
    const { camera, depthFocus, state } = this.world
    const ndc = this.point.copy(light.sunApparent).multiplyScalar(400).add(camera.position)
    ndc.project(camera)
    const target = showSun
      ? flareStrength(ndc, light.sunDirection.y) *
        this.sunInView(light) *
        light.weatherDiffuse ** 4 *
        (1 - fog) ** 2
      : 0
    // Eases in and out over a few frames, so a crown swaying across the disc does not blink it.
    this.level += (target - this.level) * (state.reducedMotion ? 1 : 0.2)
    depthFocus.setFlare((ndc.x + 1) / 2, (ndc.y + 1) / 2, this.level * state.intro)
  }

  /** 1 when nothing solid (ground, rock, crown) stands between the eye and the sun, else 0. */
  private sunInView(light: LightingState) {
    const origin = this.world.camera.position,
      direction = light.sunApparent
    if (this.world.physics.castDistance(origin, direction, 400) !== null) return 0
    return this.world.picker.crownDistance(origin, direction, Infinity) < Infinity ? 0 : 1
  }
}
