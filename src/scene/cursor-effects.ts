import { Vector2, Vector3 } from 'three/webgpu'

import { sampleWaterfallHit, WATERFALL_OCCLUSION_TOLERANCE } from './cursor-world'
import { WATER_LEVEL } from './lake-bed'
import type { WaterfallSite } from './lake-world'
import type { LandscapeInput } from './landscape-input'
import type { LandscapeState } from './landscape-state'
import type { PointerLight } from './pointer-light'
import type { RainEffect } from './rain-effect'
import type { SceneDetails } from './scene-details'
import type { ScenePicker } from './scene-picking'
import type { SkyCursorTrace } from './sky-cursor-trace'

export type CursorWorld = Readonly<{
  picker: ScenePicker
  input: LandscapeInput
  state: Readonly<LandscapeState>
  pointerLight: PointerLight
  waterfall: WaterfallSite | undefined
  details: SceneDetails | undefined
  cursorTrace: SkyCursorTrace
  rain: RainEffect
}>

/**
 * What the cursor does to the scene by merely pointing, from the frame's pointer ray: a lamp
 * at night where it rests, and relief valves for the waterfall (a hand in the curtain), the
 * clouds (a press on the open sky parts them) and the rain (an umbrella).
 */
export class CursorEffects {
  private readonly world: CursorWorld
  private readonly lightHit = new Vector3()
  private readonly blockPoint = new Vector2(0, 0)
  private blockStrength = 0
  private readonly umbrella

  constructor(world: CursorWorld, umbrellaRadius: number) {
    this.world = world
    this.umbrella = { x: 0, y: 0, z: 0, radius: umbrellaRadius }
  }

  /** The pointer light at night, on the first solid or water under a mouse; its contact. */
  updatePointerLight(
    pointerOnScene: boolean,
    waterPoint: Vector3 | null,
    nightStrength: number,
    dt: number,
  ) {
    const { picker, input, state } = this.world
    let contact: Vector3 | null = null
    if (nightStrength > 0 && pointerOnScene && input.pointerType === 'mouse' && state.focused) {
      const ray = picker.ray
      const solid = picker.solidDistance()
      if (solid < Infinity && (!waterPoint || solid < ray.origin.distanceTo(waterPoint)))
        contact = ray.at(solid, this.lightHit)
      else contact = waterPoint
    }
    this.world.pointerLight.update(
      contact,
      picker.ray.direction,
      nightStrength * state.intro,
      dt,
      state.reducedMotion,
      picker.ray.origin,
    )
    return contact
  }

  /** Cursor relief valves for the waterfall, clouds and rain; trails heal on their own. */
  update(pointerOnScene: boolean, waterPoint: Vector3 | null, dt: number, activeDelta: number) {
    const { picker, input, state, waterfall, details, rain } = this.world
    const ray = picker.ray
    let solid: number | null = null
    const solidDistance = () => {
      if (solid === null) solid = picker.solidDistance()
      return solid
    }
    let blockTarget = 0
    if (pointerOnScene && !state.reducedMotion && waterfall && details) {
      const hit = sampleWaterfallHit(ray.origin, ray.direction, waterfall, WATER_LEVEL)
      const waterDistance = waterPoint ? ray.origin.distanceTo(waterPoint) : Infinity
      if (
        hit &&
        hit.distance < waterDistance &&
        solidDistance() > hit.distance - WATERFALL_OCCLUSION_TOLERANCE
      ) {
        this.blockPoint.set(hit.across, hit.height)
        blockTarget = hit.strength * state.intro
      }
    }
    const rate = state.reducedMotion
      ? 1
      : 1 - Math.exp(-Math.max(0, dt) * (blockTarget > this.blockStrength ? 18 : 4.5))
    this.blockStrength += (blockTarget - this.blockStrength) * rate
    if (Math.abs(this.blockStrength - blockTarget) < 0.0005) this.blockStrength = blockTarget
    details?.setWaterfallBlock(this.blockPoint.x, this.blockPoint.y, 0.24, this.blockStrength)
    const skyPointer =
      (input.primaryMouseDown || input.skyPointerId >= 0) &&
      pointerOnScene &&
      !state.reducedMotion &&
      !waterPoint &&
      ray.direction.y > 0.02 &&
      solidDistance() === Infinity
        ? ray.direction
        : null
    if (!state.reducedMotion) this.world.cursorTrace.update(skyPointer, activeDelta, state.intro)
    if (pointerOnScene && !state.reducedMotion && rain.group.visible) {
      this.umbrella.x = ray.origin.x + ray.direction.x * 14
      this.umbrella.y = ray.origin.y + ray.direction.y * 14
      this.umbrella.z = ray.origin.z + ray.direction.z * 14
      rain.setRepulsor(this.umbrella)
    } else {
      rain.setRepulsor(null)
    }
  }
}
