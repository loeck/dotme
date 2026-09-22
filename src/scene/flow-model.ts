export type FlowVariant = 'desktop' | 'mobile'

export type Vec2 = Readonly<{ x: number; y: number }>

export type FlowCurve = Readonly<{
  start: Vec2
  controlA: Vec2
  controlB: Vec2
  end: Vec2
}>

export type FlowPath = readonly [FlowCurve, FlowCurve, FlowCurve]

export const FLOW_BREAKS = [0.42, 0.7] as const

/**
 * The visual source of truth for both WebGL and the server-rendered SVG.
 * Values live in a 0..1 composition space so the SVG needs no browser APIs.
 */
export const FLOW_PATHS: Record<FlowVariant, FlowPath> = {
  desktop: [
    {
      start: { x: -0.08, y: 0.82 },
      controlA: { x: 0.13, y: 0.77 },
      controlB: { x: 0.34, y: 0.7 },
      end: { x: 0.46, y: 0.62 },
    },
    {
      start: { x: 0.46, y: 0.62 },
      controlA: { x: 0.56, y: 0.553 },
      controlB: { x: 0.63, y: 0.45 },
      end: { x: 0.71, y: 0.355 },
    },
    {
      start: { x: 0.71, y: 0.355 },
      controlA: { x: 0.8, y: 0.25 },
      controlB: { x: 0.96, y: 0.22 },
      end: { x: 1.12, y: 0.31 },
    },
  ],
  mobile: [
    {
      start: { x: 0.34, y: 1.1 },
      controlA: { x: 0.42, y: 0.91 },
      controlB: { x: 0.7, y: 0.82 },
      end: { x: 0.64, y: 0.68 },
    },
    {
      start: { x: 0.64, y: 0.68 },
      controlA: { x: 0.5, y: 0.59 },
      controlB: { x: 0.5, y: 0.43 },
      end: { x: 0.69, y: 0.31 },
    },
    {
      start: { x: 0.69, y: 0.31 },
      controlA: { x: 0.78, y: 0.17 },
      controlB: { x: 0.92, y: 0.04 },
      end: { x: 0.88, y: -0.12 },
    },
  ],
}

export const FLOW_QUALITY = {
  desktop: {
    filaments: 52,
    segments: 128,
    particles: 260,
    maxPixelRatio: 1.5,
  },
  mobile: {
    filaments: 32,
    segments: 96,
    particles: 160,
    maxPixelRatio: 1.25,
  },
} as const

export function cubicPoint(curve: FlowCurve, t: number): Vec2 {
  const inverse = 1 - t
  const inverseSquared = inverse * inverse
  const tSquared = t * t

  return {
    x:
      inverseSquared * inverse * curve.start.x +
      3 * inverseSquared * t * curve.controlA.x +
      3 * inverse * tSquared * curve.controlB.x +
      tSquared * t * curve.end.x,
    y:
      inverseSquared * inverse * curve.start.y +
      3 * inverseSquared * t * curve.controlA.y +
      3 * inverse * tSquared * curve.controlB.y +
      tSquared * t * curve.end.y,
  }
}

function pathSection(path: FlowPath, t: number): Readonly<{ curve: FlowCurve; t: number }> {
  const [firstBreak, secondBreak] = FLOW_BREAKS
  if (t < firstBreak) return { curve: path[0], t: t / firstBreak }
  if (t < secondBreak) {
    return { curve: path[1], t: (t - firstBreak) / (secondBreak - firstBreak) }
  }
  return { curve: path[2], t: (t - secondBreak) / (1 - secondBreak) }
}

export function pathPoint(path: FlowPath, t: number): Vec2 {
  const section = pathSection(path, t)
  return cubicPoint(section.curve, section.t)
}
