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

export const TRANSMISSION_DURATION = 3000

/**
 * The visual source of truth for both WebGL and the server-rendered SVG.
 * Values live in a 0..1 composition space so the SVG needs no browser APIs.
 */
export const FLOW_PATHS: Record<FlowVariant, FlowPath> = {
  desktop: [
    {
      start: { x: 0.08, y: 0.59 },
      controlA: { x: 0.22, y: 0.57 },
      controlB: { x: 0.38, y: 0.6 },
      end: { x: 0.46, y: 0.62 },
    },
    {
      start: { x: 0.46, y: 0.62 },
      controlA: { x: 0.56, y: 0.6 },
      controlB: { x: 0.66, y: 0.42 },
      end: { x: 0.738, y: 0.335 },
    },
    {
      start: { x: 0.738, y: 0.335 },
      controlA: { x: 0.82, y: 0.28 },
      controlB: { x: 0.95, y: 0.18 },
      end: { x: 1.1, y: 0.2 },
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
    filaments: 38,
    segments: 128,
    particles: 250,
    maxPixelRatio: 1.5,
  },
  mobile: {
    filaments: 24,
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

export function nearestPathProgress(
  path: FlowPath,
  target: Vec2,
  aspect: number,
  samples = 96,
): number {
  let nearest = 0
  let nearestDistance = Number.POSITIVE_INFINITY

  for (let index = 0; index <= samples; index += 1) {
    const progress = index / samples
    const candidate = pathPoint(path, progress)
    const distance = Math.hypot((candidate.x - target.x) * aspect, candidate.y - target.y)
    if (distance < nearestDistance) {
      nearest = progress
      nearestDistance = distance
    }
  }

  return nearest
}
