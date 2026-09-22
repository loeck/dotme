export type FlowVariant = 'desktop' | 'mobile'

export type Vec2 = Readonly<{ x: number; y: number }>

export type FlowCurve = Readonly<{
  start: Vec2
  controlA: Vec2
  controlB: Vec2
  end: Vec2
}>

/**
 * The visual source of truth for both WebGL and the server-rendered SVG.
 * Values live in a 0..1 composition space so the SVG needs no browser APIs.
 */
export const FLOW_CURVES: Record<FlowVariant, FlowCurve> = {
  desktop: {
    start: { x: -0.12, y: 0.68 },
    controlA: { x: 0.28, y: 0.79 },
    controlB: { x: 0.56, y: 0.22 },
    end: { x: 1.13, y: 0.43 },
  },
  mobile: {
    start: { x: 0.18, y: 1.11 },
    controlA: { x: 0.57, y: 0.85 },
    controlB: { x: 0.38, y: 0.45 },
    end: { x: 0.91, y: -0.1 },
  },
}

export const FLOW_QUALITY = {
  desktop: {
    connections: 18,
    filaments: 64,
    segments: 128,
    particles: 400,
    maxPixelRatio: 1.5,
  },
  mobile: {
    connections: 8,
    filaments: 32,
    segments: 96,
    particles: 160,
    maxPixelRatio: 1.25,
  },
} as const

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

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

export function cubicTangent(curve: FlowCurve, t: number): Vec2 {
  const inverse = 1 - t
  return {
    x:
      3 * inverse * inverse * (curve.controlA.x - curve.start.x) +
      6 * inverse * t * (curve.controlB.x - curve.controlA.x) +
      3 * t * t * (curve.end.x - curve.controlB.x),
    y:
      3 * inverse * inverse * (curve.controlA.y - curve.start.y) +
      6 * inverse * t * (curve.controlB.y - curve.controlA.y) +
      3 * t * t * (curve.end.y - curve.controlB.y),
  }
}

export function pointOnFilament(curve: FlowCurve, t: number, lane: number, phase = 0): Vec2 {
  const point = cubicPoint(curve, t)
  const tangent = cubicTangent(curve, t)
  const length = Math.hypot(tangent.x, tangent.y) || 1
  const normal = { x: -tangent.y / length, y: tangent.x / length }
  const envelope = 0.055 + 0.22 * Math.sin(Math.PI * t) ** 1.4
  const ripple = Math.sin(t * 10.4 + phase) * 0.012
  const offset = lane * envelope + ripple

  return { x: point.x + normal.x * offset, y: point.y + normal.y * offset }
}

export function filamentPath(
  variant: FlowVariant,
  lane: number,
  phase: number,
  width = 1200,
  height = 800,
  samples = 28,
): string {
  const curve = FLOW_CURVES[variant]
  const points = Array.from({ length: samples + 1 }, (_, index) => {
    const point = pointOnFilament(curve, index / samples, lane, phase)
    return `${point.x * width} ${point.y * height}`
  })

  return `M ${points.join(' L ')}`
}
