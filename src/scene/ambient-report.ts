import { Vector3 } from 'three/webgpu'
import type { Camera } from 'three/webgpu'

import type { AmbientEnvironment } from '../audio/environment'
import { waterfallSound } from '../audio/environment'
import { panFromCameraMatrix, windPanFromCamera } from '../audio/pan'
import { WATER_LEVEL } from './lake-bed'
import type { WaterfallSite } from './lake-world'
import { wrapDay } from './solar-clock'
import type { WindState } from './wind'

/** Milliseconds between reports: the sound eases between them. */
const REPORT_INTERVAL = 250

export type AmbientFrame = Readonly<{
  now: number
  /** Seconds since midnight, possibly outside one day. */
  solarSeconds: number
  daylight: number
  wind: WindState
  rainIntensity: number
  /** The opening fade, 0–1, which also brings the waterfall up. */
  intro: number
}>

/**
 * Tells the ambient sound what the scene is doing, four times a second: the hour, daylight,
 * wind (and where it blows from in the view), rain, season and the waterfall's loudness and
 * place in the stereo field.
 */
export class AmbientReport {
  private at = -Infinity
  private readonly position = new Vector3()
  private readonly camera: Camera
  private readonly waterfall: WaterfallSite | undefined
  private readonly winter: number
  private readonly listener: ((state: AmbientEnvironment) => void) | undefined

  constructor(
    camera: Camera,
    waterfall: WaterfallSite | undefined,
    winter: number,
    listener: ((state: AmbientEnvironment) => void) | undefined,
  ) {
    this.camera = camera
    this.waterfall = waterfall
    this.winter = winter
    this.listener = listener
  }

  update(frame: AmbientFrame) {
    if (frame.now - this.at < REPORT_INTERVAL) return
    this.at = frame.now
    const camera = this.camera
    let waterfall = { intensity: 0, pan: 0 }
    if (this.waterfall) {
      const fall = this.waterfall
      this.position.set(
        fall.x + fall.direction[0] * 0.8,
        WATER_LEVEL,
        fall.z + fall.direction[1] * 0.8,
      )
      const distance = this.position.distanceTo(camera.position)
      const screenX = panFromCameraMatrix(camera.matrixWorld.elements, this.position)
      waterfall = waterfallSound(fall.width, fall.top - WATER_LEVEL, distance, screenX)
      waterfall.intensity *= frame.intro
    }
    this.listener?.({
      solarHour: wrapDay(frame.solarSeconds) / 3600,
      daylight: frame.daylight,
      windSpeed: frame.wind.speed,
      rainIntensity: frame.rainIntensity,
      waterfall,
      winter: this.winter,
      windPan: windPanFromCamera(camera.matrixWorld.elements, frame.wind.direction),
    })
  }
}
