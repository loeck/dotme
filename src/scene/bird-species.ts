import { mix, saturate, smoothstep } from './math'
import type { Season } from './season'

/**
 * The birds that cross the landscape, after common western European lake birds: carrion crows
 * and jackdaws leaving the wood, black-headed gulls circling over the water, mallards flying
 * low across it, and swifts hawking on summer evenings. Each has its silhouette, plumage and
 * way of flying; `chooseSpecies` picks one for the season, the hour and the sky.
 */
export const BIRD_SPECIES = ['crow', 'gull', 'mallard', 'swift'] as const
export type BirdSpeciesName = (typeof BIRD_SPECIES)[number]

/** Proportions in metres; the bird faces +Z with +Y up. */
export type BirdShape = Readonly<{
  span: number
  /** Bill tip to tail tip. */
  length: number
  /** Half-width and half-height of the chest. */
  girth: number
  /** How far the head stands ahead of the chest, as a share of the length (a duck's neck). */
  neck: number
  bill: number
  /** Chord at the shoulder. */
  chord: number
  /** Share of the half-wing from the shoulder to the wrist: a swift's hand is most of its wing. */
  wrist: number
  /** Chord at the wrist as a share of the shoulder's: a crow's hand is broad, a gull's narrow. */
  hand: number
  /** How far the tip sits behind the shoulder's leading edge: the swift's sickle. */
  sweep: number
  tail: number
  /** Half-width of the spread tail at its tip. */
  tailWidth: number
  /** Depth of the tail's fork; negative for a rounded or wedge tail. */
  fork: number
}>

export type BirdFlight = Readonly<{
  /** Cruising speed, metres per second. */
  speed: number
  /** Wingbeats per second in level flight. */
  flapRate: number
  /** Stroke amplitude, radians from the top of the upstroke to the bottom of the downstroke. */
  amplitude: number
  /** Share of the beat spent in the downstroke. */
  downstroke: number
  /** How much the hand folds and sweeps back on the upstroke (0–1). */
  fold: number
  /** Beats in a burst before a glide; [0, 0] never glides. */
  burst: readonly [number, number]
  /** Seconds a glide lasts. */
  glide: readonly [number, number]
  /** Shoulder and wrist angles held in a glide, radians (positive up). */
  glideShoulder: number
  glideWrist: number
  /** Hand swept back in a glide (0–1): the swift's sickle, the gull's crooked wing. */
  glideFold: number
}>

/** sRGB colours of the plumage regions; `headAlt` is the other sex or the other species. */
export type BirdPlumage = Readonly<{
  mantle: number
  wing: number
  tip: number
  /** Where the dark tip starts along the hand, 0 (wrist) to 1 (tip); 1 for none. */
  tipStart: number
  belly: number
  underwing: number
  head: number
  headAlt: number
  /** Share of birds with `headAlt`. */
  altShare: number
  bill: number
  tail: number
  roughness: number
  /** Linear reflectance at normal incidence: a crow's faint blue-purple gloss. */
  sheen: readonly [number, number, number]
}>

type FlockFormation = 'wedge' | 'v' | 'thermal' | 'hawking'

export type BirdSpecies = Readonly<{
  name: BirdSpeciesName
  /** Birds in a full flock. */
  count: number
  formation: FlockFormation
  shape: BirdShape
  flight: BirdFlight
  plumage: BirdPlumage
}>

export const SPECIES: Readonly<Record<BirdSpeciesName, BirdSpecies>> = {
  // Carrion crows and jackdaws: black, broad fingered hands, a rounded tail; rowing beats
  // about four times a second with short glides between bursts.
  crow: {
    name: 'crow',
    count: 9,
    formation: 'wedge',
    shape: {
      span: 0.98,
      length: 0.47,
      girth: 0.06,
      neck: 0.06,
      bill: 0.055,
      chord: 0.2,
      wrist: 0.46,
      hand: 0.92,
      sweep: 0.03,
      tail: 0.17,
      tailWidth: 0.075,
      fork: -0.035,
    },
    flight: {
      speed: 9,
      flapRate: 3.6,
      amplitude: 1.25,
      downstroke: 0.46,
      fold: 0.45,
      burst: [4, 9],
      glide: [0.5, 1.3],
      glideShoulder: 0.07,
      glideWrist: 0.02,
      glideFold: 0.08,
    },
    plumage: {
      mantle: 0x16171b,
      wing: 0x131418,
      tip: 0x0f1013,
      tipStart: 1,
      belly: 0x18191c,
      underwing: 0x1b1c20,
      head: 0x17181c,
      headAlt: 0x4f5156,
      altShare: 0.3,
      bill: 0x1b1b1d,
      tail: 0x121316,
      roughness: 0.74,
      sheen: [0.022, 0.022, 0.036],
    },
  },
  // Black-headed gulls: white with a pale grey mantle and black-tipped, narrow, pointed wings;
  // slow, deep beats and long glides on crooked wings, circling up over the water.
  gull: {
    name: 'gull',
    count: 6,
    formation: 'thermal',
    shape: {
      span: 1.05,
      length: 0.4,
      girth: 0.055,
      neck: 0.04,
      bill: 0.04,
      chord: 0.17,
      wrist: 0.4,
      hand: 0.72,
      sweep: 0.13,
      tail: 0.11,
      tailWidth: 0.058,
      fork: 0,
    },
    flight: {
      speed: 8,
      flapRate: 2.8,
      amplitude: 1.05,
      downstroke: 0.47,
      fold: 0.55,
      burst: [3, 6],
      glide: [2.2, 4.5],
      glideShoulder: 0.14,
      glideWrist: -0.24,
      glideFold: 0.22,
    },
    plumage: {
      mantle: 0xa9b3bc,
      wing: 0xb8c1c9,
      tip: 0x151619,
      tipStart: 0.55,
      belly: 0xf3f4f2,
      underwing: 0xe4e8ea,
      head: 0xf3f4f2,
      headAlt: 0xf3f4f2,
      altShare: 0,
      bill: 0xa63a2c,
      tail: 0xf4f5f3,
      roughness: 0.86,
      sheen: [0.025, 0.025, 0.025],
    },
  },
  // Mallards: a long neck, short pointed wings beating fast and steadily, never gliding; low
  // over the water in a line or a loose V. Drakes show a dark green head, ducks a brown one.
  mallard: {
    name: 'mallard',
    count: 7,
    formation: 'v',
    shape: {
      span: 0.88,
      length: 0.58,
      girth: 0.085,
      neck: 0.16,
      bill: 0.055,
      chord: 0.15,
      wrist: 0.45,
      hand: 0.7,
      sweep: 0.07,
      tail: 0.08,
      tailWidth: 0.05,
      fork: -0.02,
    },
    flight: {
      speed: 14,
      flapRate: 5.2,
      amplitude: 1.0,
      downstroke: 0.45,
      fold: 0.35,
      burst: [0, 0],
      glide: [0, 0],
      glideShoulder: 0,
      glideWrist: 0,
      glideFold: 0,
    },
    plumage: {
      mantle: 0x6d5f4f,
      wing: 0x695c4f,
      tip: 0x4b433b,
      tipStart: 0.35,
      belly: 0xb2a999,
      underwing: 0xe3e0d7,
      head: 0x145a2c,
      headAlt: 0x7a6149,
      altShare: 0.45,
      bill: 0xc9a43a,
      tail: 0xe5e1d6,
      roughness: 0.82,
      sheen: [0.025, 0.025, 0.025],
    },
  },
  // Common swifts: sooty brown, sickle wings longer than the body, a forked tail; flickering
  // beats and long glides, hawking for insects in loose, screaming parties on summer evenings.
  swift: {
    name: 'swift',
    count: 10,
    formation: 'hawking',
    shape: {
      span: 0.42,
      length: 0.17,
      girth: 0.022,
      neck: 0.02,
      bill: 0.008,
      chord: 0.06,
      wrist: 0.26,
      hand: 0.62,
      sweep: 0.1,
      tail: 0.07,
      tailWidth: 0.034,
      fork: 0.035,
    },
    flight: {
      speed: 11,
      flapRate: 7,
      amplitude: 0.85,
      downstroke: 0.5,
      fold: 0.25,
      burst: [3, 7],
      glide: [0.6, 1.8],
      glideShoulder: 0.02,
      glideWrist: -0.06,
      glideFold: 0.4,
    },
    plumage: {
      mantle: 0x2c2723,
      wing: 0x2a2521,
      tip: 0x24201c,
      tipStart: 0.7,
      belly: 0x302b26,
      underwing: 0x3d3732,
      head: 0x2d2824,
      headAlt: 0x2d2824,
      altShare: 0,
      bill: 0x1c1917,
      tail: 0x29241f,
      roughness: 0.88,
      sheen: [0.022, 0.022, 0.024],
    },
  },
}

/** What decides who flies: the season, the hour and the sky. */
export type FlockContext = Readonly<{
  season: Season
  /** Seconds since sunrise and until sunset (negative outside the day). */
  sinceSunrise: number
  untilSunset: number
  /** 0 clear to 1 overcast. */
  overcast: number
  /** A press on a crown startles whatever roosts there: crows and jackdaws. */
  fromCrown: boolean
}>

const hours = (seconds: number) => seconds / 3600

/** Relative odds of each species in a context; zero means never. */
export function speciesWeights(context: FlockContext): Record<BirdSpeciesName, number> {
  const { season, overcast } = context
  if (context.fromCrown) return { crow: 1, gull: 0, mallard: 0, swift: 0 }
  // Ducks flight to and from their feeding grounds at dawn and dusk.
  const twilight = Math.max(
    1 - smoothstep(0.5, 2, hours(context.sinceSunrise)),
    1 - smoothstep(0.5, 2, hours(context.untilSunset)),
  )
  // Swifts feed high in the evening, lower before rain; they are back from Africa May–August.
  const evening = smoothstep(4, 1.5, hours(context.untilSunset))
  const swiftSeason = season.summer + 0.4 * season.spring
  return {
    crow: 0.5 + 0.9 * season.winter + 0.3 * season.autumn + 0.6 * overcast,
    gull: 1 + 0.6 * season.winter + 0.3 * season.autumn,
    mallard: 0.45 + 1.1 * twilight + 0.35 * (season.autumn + season.winter),
    swift: swiftSeason * mix(0.5, 3, evening) * (1 - 0.6 * saturate(overcast)),
  }
}

/** One species drawn by `speciesWeights`; `random` returns [0, 1). */
export function chooseSpecies(context: FlockContext, random: () => number): BirdSpeciesName {
  const weights = speciesWeights(context)
  let total = 0
  for (const name of BIRD_SPECIES) total += weights[name]
  let pick = random() * total
  for (const name of BIRD_SPECIES) {
    pick -= weights[name]
    if (pick < 0 && weights[name] > 0) return name
  }
  return 'crow'
}

/** Shoulder and wrist angles (radians, positive up) and the hand's fold, 0–1. */
export type WingPose = { shoulder: number; wrist: number; fold: number }

const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t)

/**
 * The wing at `phase` (0–1) of a beat: the downstroke sweeps the extended wing from high above
 * the back to below the belly; on the upstroke the hand folds and trails, then flicks out at
 * the top. The hand lags the arm, bending up on the downstroke and down on the upstroke.
 */
export function flapPose(phase: number, flight: BirdFlight, target: WingPose): WingPose {
  const p = phase - Math.floor(phase)
  const top = 0.62 * flight.amplitude,
    bottom = -0.38 * flight.amplitude
  const down = flight.downstroke
  if (p < down) {
    const s = p / down
    target.shoulder = top + (bottom - top) * ease(s)
    target.wrist = 0.3 * flight.amplitude * Math.sin(Math.PI * s)
    target.fold = 0
  } else {
    const s = (p - down) / (1 - down)
    target.shoulder = bottom + (top - bottom) * ease(s)
    target.wrist = -0.45 * flight.amplitude * Math.sin(Math.PI * s)
    target.fold = flight.fold * Math.sin(Math.PI * Math.min(1, s * 1.15))
  }
  return target
}

/** Per-bird wing state for `stepWing`. */
export type WingState = {
  phase: number
  /** Beats left in this burst, and seconds left of a glide. */
  beats: number
  gliding: number
  /** 0 flapping to 1 gliding, eased. */
  glide: number
  /** Beat rate factor of this bird: a little faster or slower than the species. */
  rate: number
}

/**
 * Advances a bird's wings: bursts of beats, then a glide on held wings, then beats again. A
 * climbing bird does not glide and beats a little faster. Returns the pose in `target`.
 */
export function stepWing(
  wing: WingState,
  flight: BirdFlight,
  dt: number,
  climbing: boolean,
  random: () => number,
  target: WingPose,
): WingPose {
  const glides = flight.burst[1] > 0
  if (wing.gliding > 0) {
    wing.gliding -= dt
    if (wing.gliding <= 0 || climbing) {
      wing.gliding = 0
      wing.beats = mix(flight.burst[0], flight.burst[1], random())
      // Back to beating from the top of the stroke, as a bird does after a glide.
      wing.phase = Math.floor(wing.phase) + 1 + flight.downstroke * 0.05
    }
  } else {
    const before = wing.phase
    wing.phase += dt * flight.flapRate * wing.rate * (climbing ? 1.15 : 1)
    // A glide starts at the top of a beat, with the wings spread.
    if (glides && !climbing && Math.floor(wing.phase) > Math.floor(before)) {
      wing.beats -= 1
      if (wing.beats <= 0) wing.gliding = mix(flight.glide[0], flight.glide[1], random())
    }
  }
  const goal = wing.gliding > 0 ? 1 : 0
  wing.glide += (goal - wing.glide) * (1 - Math.exp(-dt * (goal ? 9 : 14)))
  flapPose(wing.phase, flight, target)
  const g = wing.glide
  target.shoulder = mix(target.shoulder, flight.glideShoulder, g)
  target.wrist = mix(target.wrist, flight.glideWrist, g)
  target.fold = mix(target.fold, flight.glideFold, g)
  return target
}
