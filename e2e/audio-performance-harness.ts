import { AmbientMixer } from '../src/audio/ambient-mixer'
let context: AudioContext | undefined
let mixer: AmbientMixer | undefined
export async function start() {
  context = new AudioContext({ sampleRate: 32000 })
  await context.resume()
  mixer = new AmbientMixer(context)
  mixer.setEnvironment({ solarHour: 0, daylight: 0, windSpeed: 3, rainIntensity: 0 })
  await mixer.load()
  mixer.resume()
}
export function stop() {
  mixer?.dispose()
  void context?.close()
}
