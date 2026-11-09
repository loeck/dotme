/** The engine's live frame state, shared by reference with the subsystems that read it. */
export type LandscapeState = {
  /** Scene seconds: the simulation clock, which stands still under reduced motion. */
  elapsed: number
  /** 0–1 over the opening fade. */
  intro: number
  reducedMotion: boolean
  /** Daylight of the last frame, for gestures between frames. */
  daylight: number
  /** The page has focus: full frame rate and a live cursor. */
  focused: boolean
}
