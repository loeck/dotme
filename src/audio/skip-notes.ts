/**
 * Notes for a skipping stone, tuned to the music. A chromagram of the shipped pieces puts the
 * day piece in C major (G, B, E and C strongest, F well above F♯) and the night piece in
 * F major (F, C, A and D). Each skip climbs the major pentatonic of the current mood, which
 * holds no semitone against either piece; the stone sinks on the root an octave lower.
 */
const DAY_SCALE = [72, 74, 76, 79, 81] as const // C5 D5 E5 G5 A5
const NIGHT_SCALE = [65, 67, 69, 72, 74] as const // F4 G4 A4 C5 D5

export const midiFrequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12)

export function skipNote(index: number, sinking: boolean, daylight: number) {
  const scale = daylight >= 0.5 ? DAY_SCALE : NIGHT_SCALE
  if (sinking) return midiFrequency(scale[0] - 12)
  const step = Math.max(0, Math.floor(index))
  const octave = Math.floor(step / scale.length)
  return midiFrequency((scale[step % scale.length] ?? scale[0]) + 12 * Math.min(octave, 1))
}

/** A stone's touchdown as the mixer hears it, already placed in the view. */
export type SkipNoteEvent = Readonly<{
  index: number
  sinking: boolean
  /** 0–1 after distance attenuation. */
  intensity: number
  /** -1 (left) to 1 (right). */
  pan: number
}>
