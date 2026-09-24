import { AmbientMixer } from '../src/audio/ambient-mixer'
import type { AudioFormat } from '../src/audio/ambient-mixer'
import { required } from '../src/invariant'
import { deferred } from './deferred'

/** Render three minutes with the actual decoded clips, mixer and scheduling code. */
export async function auditAudio(format: AudioFormat) {
  const offline = new OfflineAudioContext(2, 180 * 32000, 32000)
  let time = 0
  const { promise: waterfallReady, resolve: waterfallConnected } = deferred()
  const clock = {
    get currentTime() {
      return time
    },
    state: 'running',
    destination: offline.destination,
    createGain: () => offline.createGain(),
    createStereoPanner: () => {
      const panner = offline.createStereoPanner()
      waterfallConnected()
      return panner
    },
    createBufferSource: () => offline.createBufferSource(),
    decodeAudioData: (data: ArrayBuffer) => offline.decodeAudioData(data),
  }
  const mixer = new AmbientMixer(clock, format)
  const daylight = { solarHour: 12, daylight: 1, rainIntensity: 0, windSpeed: 2 }
  mixer.setEnvironment({ ...daylight, waterfall: { intensity: 1, pan: -0.7 } })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await mixer.load()
    mixer.resume()
    await Promise.race([
      waterfallReady,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Waterfall audio was not connected')), 15000)
      }),
    ])
  } catch (error) {
    mixer.dispose()
    throw error
  } finally {
    clearTimeout(deadline)
  }
  mixer.setEnvironment(daylight)
  mixer.resume()
  // The mono base layers cancel in L-R, exposing the panned waterfall without
  // reaching into private mixer gains or replacing any recording with a tone.
  for (let i = 1; i < 720; i++) {
    time = i / 4
    if (i % 120 === 0) {
      const environment =
        time < 60
          ? daylight
          : time < 120
            ? { solarHour: 18, daylight: 0.5, rainIntensity: 1, windSpeed: 12 }
            : { solarHour: 0, daylight: 0, rainIntensity: 0.2, windSpeed: 3 }
      const waterfall =
        time >= 30 && time < 90
          ? { intensity: 1, pan: -0.7 }
          : time >= 120 && time < 150
            ? { intensity: 1, pan: 0.7 }
            : undefined
      mixer.setEnvironment(waterfall ? { ...environment, waterfall } : environment)
    }
    mixer.resume()
  }
  const result = await offline.startRendering()
  mixer.dispose()
  const left = result.getChannelData(0),
    right = result.getChannelData(1)
  let peak = 0,
    maxStep = 0,
    sum = 0,
    differenceSum = 0
  const rms: number[] = [],
    waterfallRms: number[] = []
  for (let i = 0; i < left.length; i++) {
    const l = required(left[i]),
      r = required(right[i])
    peak = Math.max(peak, Math.abs(l), Math.abs(r))
    if (i)
      maxStep = Math.max(
        maxStep,
        Math.abs(l - required(left[i - 1])),
        Math.abs(r - required(right[i - 1])),
      )
    sum += (l * l + r * r) / 2
    differenceSum += (l - r) ** 2
    if ((i + 1) % 32000 === 0) {
      rms.push(Math.sqrt(sum / 32000))
      waterfallRms.push(Math.sqrt(differenceSum / 32000))
      sum = 0
      differenceSum = 0
    }
  }
  return {
    peak,
    maxStep,
    rms,
    waterfallRms,
    seconds: result.duration,
    decodedBytes: result.length * result.numberOfChannels * 4,
  }
}
