import { Plane, Vector2, Vector3 } from 'three/webgpu'
import type { PerspectiveCamera } from 'three/webgpu'

import type { FishBait } from './fish-pointer'
import { WATER_LEVEL } from './lake-bed'
import { isDoubleTap } from './lake-lanterns'
import type { LakeLanterns } from './lake-lanterns'
import type { LandscapeState } from './landscape-state'
import { clamp } from './math'
import type { PhysicsWorld } from './physics-world'
import type { SceneDetails } from './scene-details'
import { placeSound } from './scene-picking'
import type { ScenePicker } from './scene-picking'
import { SKIP, flickOrigin, planSkips } from './stone-skips'
import type { FlickSample, SkippingStone } from './stone-skips'
import { SCRUB, wheelPixels } from './time-scrub'
import type { TimeScrub } from './time-scrub'
import { waterStroke } from './water-pointer'
import { shockImpulse } from './water-shockwave'
import type { WaterShockwave } from './water-shockwave'
import type { WaterSimulation } from './water-simulation'
import type { WindModel, WindState } from './wind'
import type { WindGusts } from './wind-gusts'

/** A long press on the water released as a wave, placed in the view. */
export type ShockwaveEvent = Readonly<{
  /** 0–1: how long the press was held. */
  charge: number
  /** 0–1 after distance attenuation. */
  intensity: number
  /** -1 (left) to 1 (right). */
  pan: number
  pointerType: string
}>

/** Each touchdown of a thrown stone, placed in the view. */
export type StoneTouchdownEvent = Readonly<{
  /** 0 where the stone lands, then one per skip. */
  index: number
  /** The last touchdown, where the stone sinks. */
  sinking: boolean
  /** Splash energy in [0, 1]. */
  energy: number
  /** 0–1 after distance attenuation. */
  intensity: number
  /** -1 (left) to 1 (right). */
  pan: number
  /** Pointer type of the throw, or `demo` for the scene's own. */
  pointerType: string
}>

/** Seconds between the faint ripples a charging press draws on the water. */
const SHOCK_RIPPLE = 0.3

/** Screen points, as shares of the canvas, where the demonstration stone may land. */
const DEMO_LANDINGS = [
  [0.5, 0.74],
  [0.42, 0.7],
  [0.58, 0.7],
  [0.5, 0.82],
] as const

type PointerSample = { x: number; y: number; time: number }

export type InputWorld = Readonly<{
  canvas: HTMLCanvasElement
  camera: PerspectiveCamera
  picker: ScenePicker
  state: Readonly<LandscapeState>
  physics: Pick<PhysicsWorld, 'castDistance'>
  simulation: Pick<WaterSimulation, 'addImpulse' | 'heightAt' | 'contact'>
  wind: WindModel
  shockwave: WaterShockwave
  stone: SkippingStone
  scrub: TimeScrub
  lanterns: LakeLanterns
  details: SceneDetails | undefined
  isOpenWater: (x: number, z: number) => boolean
  requestFrame: () => void
  /** A press on a crown by day: true when it startled a flock. Reads the press's pointer ray. */
  startleCrown: () => boolean
  /** A press on the clear night sky. Reads the press's pointer ray. */
  wishOnStar: () => void
  onShockwave?: ((event: ShockwaveEvent) => void) | undefined
  onStoneTouchdown?: ((event: StoneTouchdownEvent) => void) | undefined
}>

/**
 * The visitor's hands on the scene: the mouse, touches and the wheel. A press on the water
 * stirs it and charges a wave, a flick throws a stone, a double tap at night floats a lantern,
 * a press on a floater grabs it, two fingers or the wheel scrub the day. The engine reads the
 * pointer state each frame; between frames the handlers only record and enqueue.
 */
export class LandscapeInput {
  /** The client position of the pointer. */
  readonly client = new Vector2(-1, -1)
  /** The pointer over the canvas, -1–1 on both axes, for the camera's parallax. */
  readonly target = new Vector2(0, 0)
  /** The water point under the pointer (x, z) and the reveal's strength (z), for the shader. */
  readonly waterTarget = new Vector3(0, 0, 0)
  /** The pointer's client position last frame, for the screen speed of a sweep. */
  private readonly sweepClient = new Vector2(Number.NaN, Number.NaN)
  private readonly sweepFrom = new Vector3()
  private readonly sweepTo = new Vector3()
  /** The container's size in CSS pixels; the engine sets it on resize. */
  readonly size = { width: 1, height: 1 }
  active = false
  pointerType = 'mouse'
  primaryMouseDown = false
  skyPointerId = -1
  grabPointerId = -1
  /** When the mouse last moved or pressed, in ms: a still cursor gathers the fireflies. */
  stillSince = 0
  /** True once the visitor has pressed the scene; until then a demonstration stone is due. */
  interacted = false
  demoThrown = false
  /** Pointer type of the stone in flight, or `demo` for the scene's own. */
  stoneThrower = 'mouse'
  /** Where a press on the water draws the fish, and when. */
  bait: { x: number; z: number; born: number } | null = null
  private readonly world: InputWorld
  private dragging = false
  private dragPointerId = -1
  private revision = 0
  private busy = false
  private pending: PointerSample | null = null
  private previous: PointerSample | null = null
  private disposed = false
  private readonly grabPlane = new Plane()
  private readonly grabNormal = new Vector3()
  private readonly grabPoint = new Vector3()
  /** Just under the resting lake: dragged below the waterline, the buoy ploughs along it. */
  private readonly grabWater = new Plane(new Vector3(0, 1, 0), -(WATER_LEVEL - 0.04))
  // Separate targets: processPointer() runs inside render() and must not overwrite the
  // frame's water point, nor a stroke's endpoints while it samples between them.
  private readonly pressPoint = new Vector3()
  private readonly strokeStart = new Vector3()
  private readonly strokeEnd = new Vector3()
  private readonly strokeSample = new Vector3()
  private readonly strokeContact = new Vector3()
  /** Recent screen positions of the dragging pointer, to read a flick's speed at release. */
  private readonly flick: FlickSample[] = []
  private readonly flickStart = new Vector3()
  private readonly flickEnd = new Vector3()
  private readonly stoneHand = new Vector3()
  private readonly soundPosition = new Vector3()
  /** The last tap on the water that threw nothing, for a double tap to set a lantern afloat. */
  private lastTap: PointerSample | null = null
  private readonly lanternPoint = new Vector3()
  /** Vertical positions of the touches on the scene, for the two-finger time scrub. */
  private readonly touches = new Map<number, number>()
  private nextShockRipple = 0

  constructor(world: InputWorld) {
    this.world = world
  }

  /** Same order as the handlers always ran: per event type, the pointer before the touches. */
  addListeners() {
    const canvas = this.world.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove, { passive: true })
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.leave)
    canvas.addEventListener('lostpointercapture', this.onLostCapture)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('pointerdown', this.onTouchDown)
    window.addEventListener('pointermove', this.onTouchMove, { passive: true })
    window.addEventListener('pointerup', this.onTouchUp)
    window.addEventListener('pointercancel', this.onTouchUp)
  }

  removeListeners() {
    const canvas = this.world.canvas
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    canvas.removeEventListener('pointerleave', this.leave)
    canvas.removeEventListener('lostpointercapture', this.onLostCapture)
    canvas.removeEventListener('wheel', this.onWheel)
    canvas.removeEventListener('pointerdown', this.onTouchDown)
    window.removeEventListener('pointermove', this.onTouchMove)
    window.removeEventListener('pointerup', this.onTouchUp)
    window.removeEventListener('pointercancel', this.onTouchUp)
  }

  /** Releases any press and stops reacting; outstanding readbacks are dropped. */
  dispose() {
    this.leave()
    this.disposed = true
    this.revision += 1
    this.removeListeners()
  }

  /** Reprojects the newest queued pointer move into strokes on the water, one at a time. */
  pump() {
    if (this.pending && !this.busy)
      void this.processPointer().catch(() => {
        this.previous = null
      })
  }

  private async processPointer() {
    const event = this.pending
    if (!event || this.busy || this.disposed) return
    const { picker, simulation, camera } = this.world
    this.pending = null
    this.busy = true
    const revision = this.revision
    try {
      let point = picker.hitWater(event.x, event.y, this.strokeEnd)
      if (!point) {
        this.previous = null
        return
      }
      picker.pointerHeight = await simulation.heightAt(point.x, point.z)
      if (this.disposed || revision !== this.revision) return
      point = picker.hitWater(event.x, event.y, this.strokeEnd)
      if (!point) {
        this.previous = null
        return
      }
      const previous = this.previous
      if (previous && (event.x !== previous.x || event.y !== previous.y)) {
        // Reproject both client positions with the SAME camera. Parallax is never input energy.
        const start = picker.hitWater(previous.x, previous.y, this.strokeStart)
        if (start) {
          const distance = start.distanceTo(point)
          const pixels = Math.hypot(event.x - previous.x, event.y - previous.y)
          const { samples, radius, velocity } = waterStroke(
            pixels,
            (event.time - previous.time) / 1000,
            distance,
            this.dragging,
          )
          const projected = this.strokeSample
          const bounds = picker.canvasBounds()
          for (let i = 1; i <= samples; i++) {
            // Equal world spacing avoids bunching pressure samples at the near
            // end of a vertical screen stroke. Still reject occluded/UI samples.
            projected
              .copy(start)
              .lerp(point, (i - 0.5) / samples)
              .project(camera)
            const contact = picker.hitWater(
              bounds.left + (projected.x + 1) * bounds.width * 0.5,
              bounds.top + (1 - projected.y) * bounds.height * 0.5,
              this.strokeContact,
            )
            if (contact) simulation.addImpulse(contact.x, contact.z, radius, velocity)
          }
        }
      }
      this.previous = event
    } finally {
      this.busy = false
    }
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return
    const { camera, canvas, details, picker, state, wind } = this.world
    this.interacted = true
    this.stillSince = performance.now()
    details?.scatterFireflies()
    this.primaryMouseDown = event.pointerType === 'mouse'
    this.pointerType = event.pointerType
    this.active = true
    this.client.set(event.clientX, event.clientY)
    if (state.reducedMotion) {
      this.world.requestFrame()
      return
    }
    if (picker.project(event.clientX, event.clientY)) {
      const ray = picker.ray
      const padding =
        (2 * Math.tan((camera.fov * Math.PI) / 360) * (event.pointerType === 'touch' ? 18 : 10)) /
        this.size.height
      const solid = this.world.physics.castDistance(ray.origin, ray.direction, 130) ?? 130
      const buoy = details?.grabFloater(ray, padding, solid)
      if (buoy) {
        this.grabPointerId = event.pointerId
        this.grabPlane.setFromNormalAndCoplanarPoint(
          camera.getWorldDirection(this.grabNormal),
          buoy,
        )
        this.previous = this.pending = null
        this.revision += 1
        this.lastTap = null
        document.documentElement.dataset.sceneGrab = 'true'
        canvas.setPointerCapture(event.pointerId)
        return
      }
    }
    const point = picker.hitWater(event.clientX, event.clientY, this.pressPoint)
    // Off the water, the press may startle birds from a crown or make a wish on the night sky;
    // both read the pointer ray, so it must have been cast for this very press.
    if (!point && picker.project(event.clientX, event.clientY)) {
      if (this.world.startleCrown()) return
      this.world.wishOnStar()
    }
    if (!point) {
      if (event.pointerType === 'touch') {
        this.skyPointerId = event.pointerId
        canvas.setPointerCapture(event.pointerId)
      }
      return
    }
    this.bait = { x: point.x, z: point.z, born: state.elapsed }
    details?.pointerBurst(point.x, point.z, 0.55, state.elapsed, wind.sample(state.elapsed))
    this.dragging = true
    this.dragPointerId = event.pointerId
    this.pointerType = event.pointerType
    this.active = true
    this.client.set(event.clientX, event.clientY)
    this.previous = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    this.pending = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    this.flick.length = 0
    this.flick.push({ x: event.clientX, y: event.clientY, time: event.timeStamp })
    this.world.shockwave.start(
      point.x,
      point.z,
      event.clientX,
      event.clientY,
      performance.now() / 1000,
    )
    canvas.setPointerCapture(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent) => {
    if (!this.world.state.focused || document.hidden) return
    if (
      !event.isPrimary ||
      (this.grabPointerId >= 0 && event.pointerId !== this.grabPointerId) ||
      (this.dragging && event.pointerId !== this.dragPointerId) ||
      (this.skyPointerId >= 0 && event.pointerId !== this.skyPointerId)
    )
      return
    this.pointerType = event.pointerType
    this.primaryMouseDown = event.pointerType === 'mouse' && (event.buttons & 1) !== 0
    this.active = event.pointerType !== 'touch' || event.buttons !== 0
    if (this.grabPointerId >= 0) {
      this.client.set(event.clientX, event.clientY)
      this.moveGrabbedFloater()
      if ((event.buttons & 1) === 0) this.leave()
      return
    }
    this.target.set(
      clamp((event.clientX / this.size.width) * 2 - 1, -1, 1),
      clamp((event.clientY / this.size.height) * 2 - 1, -1, 1),
    )
    if (this.client.x === event.clientX && this.client.y === event.clientY) return
    this.client.set(event.clientX, event.clientY)
    this.stillSince = performance.now()
    if (this.world.state.reducedMotion) {
      this.world.requestFrame()
      return
    }
    if (!this.active) {
      this.previous = null
      this.pending = null
      this.revision += 1
      return
    }
    this.pending = {
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    }
    if (this.dragging) {
      this.world.shockwave.move(event.clientX, event.clientY)
      this.flick.push({ x: event.clientX, y: event.clientY, time: event.timeStamp })
      if (this.flick.length > 12) this.flick.shift()
    }
  }

  /**
   * A quick flick across the water throws a stone: it lands where the gesture ended and skips
   * on in the gesture's direction, further for a faster flick. Speed is read on the water plane
   * over at least the gesture's last 40 ms, so a slow drag only stirs the surface.
   */
  private throwStone(event: PointerEvent): boolean {
    if (this.world.state.reducedMotion || this.disposed) return false
    // Measure from the newest sample at least 40 ms old, or from the press. The newest move
    // often sits on the release point itself when events arrive coalesced on a busy frame.
    const from = flickOrigin(this.flick, event.timeStamp)
    this.flick.length = 0
    const elapsed = from ? event.timeStamp - from.time : 0
    if (!from || elapsed < 8 || elapsed > 300) return false
    const start = this.world.picker.hitWater(from.x, from.y, this.flickStart)
    const end = start && this.world.picker.hitWater(event.clientX, event.clientY, this.flickEnd)
    if (!start || !end) return false
    const seconds = elapsed / 1000
    const dx = end.x - start.x,
      dz = end.z - start.z
    const speed = Math.hypot(dx, dz) / seconds
    // A tap or a slow drag throws nothing.
    if (!(speed >= SKIP.minSpeed)) return false
    this.throwFrom(end, { x: dx, z: dz }, speed, event.pointerType)
    return true
  }

  /** A double tap on the night lake sets a paper lantern afloat where it landed. */
  private tapWater(event: PointerEvent) {
    const tap = { x: event.clientX, y: event.clientY, time: event.timeStamp }
    const double = isDoubleTap(this.lastTap, tap)
    this.lastTap = double ? null : tap
    if (!double || this.world.state.daylight > 0.25) return
    const point = this.world.picker.hitWater(event.clientX, event.clientY, this.lanternPoint)
    if (point) this.world.lanterns.place(point.x, point.z, this.world.state.elapsed)
  }

  /**
   * A long press let go: one broad wave rolls out from the spot to the banks, lifting what
   * floats, with a ring of splashes, a low note and, on touch, a buzz in the hand.
   */
  private releaseShockwave(
    wave: Readonly<{ x: number; z: number; charge: number }>,
    pointerType: string,
  ) {
    const { details, state, simulation } = this.world
    const { radius, velocity } = shockImpulse(wave.charge)
    simulation.addImpulse(wave.x, wave.z, radius, velocity)
    const wind = this.world.wind.sample(state.elapsed)
    const bursts = 6 + Math.round(4 * wave.charge)
    for (let i = 0; i < bursts; i++) {
      const angle = (i / bursts) * Math.PI * 2
      const x = wave.x + Math.cos(angle) * radius,
        z = wave.z + Math.sin(angle) * radius
      if (this.world.isOpenWater(x, z))
        details?.pointerBurst(x, z, 0.4 + 0.4 * wave.charge, state.elapsed, wind)
    }
    this.bait = null
    const listener = this.world.onShockwave
    if (!listener) return
    const place = placeSound(this.world.camera, wave.x, wave.z, this.soundPosition)
    listener({ charge: wave.charge, intensity: place.attenuation, pan: place.pan, pointerType })
  }

  private throwFrom(
    landing: Vector3,
    direction: { x: number; z: number },
    speed: number,
    pointerType: string,
  ) {
    const { camera } = this.world
    const plan = planSkips(landing, direction, speed, this.world.isOpenWater)
    // From a hand low and a little right of the eye, as a right-handed skimmer throws.
    this.stoneHand.set(1.2, -0.9, -1.5).applyQuaternion(camera.quaternion).add(camera.position)
    this.stoneThrower = pointerType
    this.world.stone.throw(this.stoneHand, plan, this.world.state.elapsed)
  }

  /** Shows a first visitor that the water answers: one long run of skips across the lake. */
  throwDemo() {
    this.demoThrown = true
    const { camera, picker } = this.world
    const bounds = picker.canvasBounds()
    for (const [u, v] of DEMO_LANDINGS) {
      const landing = picker.hitWater(
        bounds.left + u * bounds.width,
        bounds.top + v * bounds.height,
        this.flickEnd,
      )
      if (!landing) continue
      const direction = {
        x: landing.x - camera.position.x,
        z: landing.z - camera.position.z,
      }
      this.throwFrom(landing, direction, 16, 'demo')
      return
    }
  }

  private onPointerUp = (event: PointerEvent) => {
    if (!event.isPrimary) return
    const canvas = this.world.canvas
    if (event.button === 0 || event.type === 'pointercancel') this.primaryMouseDown = false
    if (event.pointerId === this.grabPointerId) {
      this.world.details?.releaseFloater(event.type === 'pointercancel')
      this.grabPointerId = -1
      delete document.documentElement.dataset.sceneGrab
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (event.pointerType === 'touch') this.leave()
      return
    }
    if (event.pointerId === this.skyPointerId) {
      this.leave()
      return
    }
    if (event.pointerType === 'touch' && event.pointerId !== this.dragPointerId) {
      this.leave()
      return
    }
    if (event.pointerId !== this.dragPointerId) return
    const wave =
      event.type === 'pointerup' ? this.world.shockwave.release(performance.now() / 1000) : null
    if (wave) this.releaseShockwave(wave, event.pointerType)
    else if (event.type === 'pointerup' && !this.throwStone(event)) this.tapWater(event)
    this.dragging = false
    this.dragPointerId = -1
    if (event.type === 'pointercancel' || this.pointerType === 'touch') this.leave()
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  }

  /**
   * The wheel runs the day forward (down) or back (up); the clock returns to the real hour on
   * its own a few seconds after the last turn. Pinch-zoom (ctrl + wheel) and horizontal swipes
   * are left to the browser.
   */
  private onWheel = (event: WheelEvent) => {
    if (
      this.world.state.reducedMotion ||
      event.ctrlKey ||
      Math.abs(event.deltaY) < Math.abs(event.deltaX)
    )
      return
    event.preventDefault()
    this.interacted = true
    this.world.scrub.scrub(
      wheelPixels(event.deltaY, event.deltaMode) * SCRUB.wheelSeconds,
      performance.now() / 1000,
    )
  }

  /** A second finger turns the press into a time scrub: no stone, no stirring, no sky drag. */
  private onTouchDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return
    this.touches.set(event.pointerId, event.clientY)
    if (this.touches.size === 2) this.leave()
  }

  private onTouchMove = (event: PointerEvent) => {
    const previous = this.touches.get(event.pointerId)
    if (previous === undefined) return
    this.touches.set(event.pointerId, event.clientY)
    if (this.touches.size !== 2 || this.world.state.reducedMotion) return
    // Each finger carries half the swipe: dragging both up runs the day forward.
    this.world.scrub.scrub(
      ((previous - event.clientY) / 2) * SCRUB.touchSeconds,
      performance.now() / 1000,
    )
  }

  private onTouchUp = (event: PointerEvent) => {
    this.touches.delete(event.pointerId)
  }

  private onLostCapture = () => {
    if (this.dragging || this.skyPointerId >= 0 || this.grabPointerId >= 0) this.leave()
  }

  /** The pointer left the scene, or the page lost focus: drop every press in progress. */
  leave = (event?: PointerEvent) => {
    const canvas = this.world.canvas
    if (
      event?.type === 'pointerleave' &&
      this.grabPointerId >= 0 &&
      canvas.hasPointerCapture(this.grabPointerId)
    )
      return
    this.world.shockwave.abort()
    const pointerId =
      this.grabPointerId >= 0
        ? this.grabPointerId
        : this.dragPointerId >= 0
          ? this.dragPointerId
          : this.skyPointerId
    this.world.details?.releaseFloater(true)
    this.grabPointerId = -1
    delete document.documentElement.dataset.sceneGrab
    this.primaryMouseDown = false
    this.skyPointerId = -1
    this.active = false
    this.sweepClient.set(Number.NaN, Number.NaN)
    this.dragging = false
    this.dragPointerId = -1
    this.previous = null
    this.pending = null
    this.revision += 1
    this.waterTarget.z = 0
    if (this.world.state.reducedMotion) this.world.requestFrame()
    if (pointerId >= 0 && canvas.hasPointerCapture(pointerId))
      canvas.releasePointerCapture(pointerId)
  }

  /**
   * What the gestures set going, each frame: the stone's touchdowns (splash, note and haptics),
   * the ripples under a charging press and the lanterns afloat.
   */
  updateGestures(wind: WindState, daylight: number, seconds: number) {
    this.updateStone()
    this.updateShockwave(seconds)
    const { state, lanterns, simulation } = this.world
    lanterns.update(
      state.elapsed,
      wind,
      1 - daylight,
      (x, z) => simulation.contact.sample(x, z, state.elapsed, wind)[0],
      (x, z) => this.world.isOpenWater(x, z),
      state.reducedMotion,
    )
  }

  private updateStone() {
    const { details, simulation, state } = this.world
    this.world.stone.update(state.elapsed, (touchdown, index, last) => {
      const wind = this.world.wind.sample(state.elapsed)
      const energy = last ? 0.5 : touchdown.energy
      simulation.addImpulse(touchdown.x, touchdown.z, last ? 0.5 : 0.35, -0.09 * energy)
      details?.pointerBurst(touchdown.x, touchdown.z, 0.3 + 0.35 * energy, state.elapsed, wind)
      const listener = this.world.onStoneTouchdown
      if (!listener) return
      const place = placeSound(this.world.camera, touchdown.x, touchdown.z, this.soundPosition)
      listener({
        index,
        sinking: last,
        energy,
        intensity: place.attenuation * state.intro,
        pan: place.pan,
        pointerType: this.stoneThrower,
      })
    })
  }

  /** While a press charges, faint ripples gather under it. */
  private updateShockwave(seconds: number) {
    const shockwave = this.world.shockwave
    const pressed = shockwave.pressed
    const charge = shockwave.charge(seconds)
    if (pressed && charge > 0 && seconds >= this.nextShockRipple) {
      this.nextShockRipple = seconds + SHOCK_RIPPLE
      this.world.simulation.addImpulse(pressed.x, pressed.z, 0.4, -0.03 * charge)
    }
    shockwave.update(seconds)
  }

  /** The fish's pull toward the last press on the water, fading over a few seconds. */
  baitStrength(): FishBait | null {
    const { state } = this.world
    if (!this.bait || state.reducedMotion) return null
    const strength = Math.exp(-(state.elapsed - this.bait.born) / 6) * state.intro
    if (strength > 0.01) return { x: this.bait.x, z: this.bait.z, strength }
    this.bait = null
    return null
  }

  moveGrabbedFloater() {
    if (this.grabPointerId < 0 || !this.world.picker.project(this.client.x, this.client.y)) return
    const ray = this.world.picker.ray
    let target = ray.intersectPlane(this.grabPlane, this.grabPoint)
    // The two planes cross on the waterline, so the hand slides on without a jump.
    if (target && target.y < WATER_LEVEL - 0.04)
      target = ray.intersectPlane(this.grabWater, this.grabPoint) ?? target
    if (target) this.world.details?.moveFloater(target)
  }

  /**
   * A local, damped breeze follows the screen velocity. Project both ends at the current
   * contact depth so crossing a crown's silhouette cannot invent a large movement in depth.
   */
  updateGusts(pointerOnScene: boolean, dt: number, gusts: WindGusts | undefined) {
    const previous = this.sweepClient
    const current = this.client
    const picker = this.world.picker
    const pixels = Math.hypot(current.x - previous.x, current.y - previous.y) / Math.max(dt, 1e-3)
    const ready =
      !!gusts &&
      pointerOnScene &&
      !this.world.state.reducedMotion &&
      dt > 0 &&
      pixels > 0 &&
      Number.isFinite(pixels)
    const from = ready && picker.project(previous.x, previous.y)
    if (from) this.sweepFrom.copy(picker.ray.direction)
    // Cast the newest ray last: the rest of this frame's interactions use it.
    const to = from && picker.pointAt(current.x, current.y, this.sweepTo)
    if (to && gusts) {
      this.sweepFrom.multiplyScalar(picker.ray.origin.distanceTo(to)).add(picker.ray.origin)
      gusts.update(
        {
          x: to.x,
          z: to.z,
          dx: to.x - this.sweepFrom.x,
          dz: to.z - this.sweepFrom.z,
          pixelsPerSecond: pixels,
        },
        Math.min(dt, 0.1),
      )
    } else gusts?.update(null, Math.min(dt, 0.1))
    if (pointerOnScene) previous.copy(current)
    else previous.set(Number.NaN, Number.NaN)
  }
}
