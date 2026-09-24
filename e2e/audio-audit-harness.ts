import { AmbientMixer } from '../src/audio/ambient-mixer'

/** Render three minutes with the actual decoded clips, mixer and scheduling code. */
export async function auditAudio() {
  const offline = new OfflineAudioContext(1, 180 * 32000, 32000)
  let time = 0
  const clock = {
    get currentTime() {
      return time
    },
    state: 'running',
    destination: offline.destination,
    createGain: () => offline.createGain(),
    createBufferSource: () => offline.createBufferSource(),
    decodeAudioData: (data: ArrayBuffer) => offline.decodeAudioData(data),
  }
  const mixer = new AmbientMixer(clock as unknown as AudioContext)
  await mixer.load()
  mixer.setEnvironment({ solarHour: 12, daylight: 1, rainIntensity: 0, windSpeed: 2 })
  mixer.resume()
  // Run the scheduler ahead with an audio clock; rendering remains sample-accurate.
  const schedule = (mixer as unknown as { schedule: () => void }).schedule
  for (let i = 1; i < 720; i++) {
    time = i / 4
    if (i === 240)
      mixer.setEnvironment({ solarHour: 18, daylight: 0.5, rainIntensity: 1, windSpeed: 12 })
    if (i === 480)
      mixer.setEnvironment({ solarHour: 0, daylight: 0, rainIntensity: 0.2, windSpeed: 3 })
    schedule()
  }
  const result = await offline.startRendering()
  mixer.dispose()
  const samples = result.getChannelData(0)
  let peak = 0,
    maxStep = 0,
    sum = 0
  const rms: number[] = []
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]!))
    if (i) maxStep = Math.max(maxStep, Math.abs(samples[i]! - samples[i - 1]!))
    sum += samples[i]! ** 2
    if ((i + 1) % 32000 === 0) {
      rms.push(Math.sqrt(sum / 32000))
      sum = 0
    }
  }
  return { peak, maxStep, rms, seconds: result.duration, decodedBytes: result.length * 4 }
}
