import type { FlowVariant } from './flow-model'

type Point = Readonly<{ x: number; y: number }>

type Route = Readonly<{
  alpha: number
  anchors: readonly Point[]
  layer: number
  reveal: number
  samplesPerSection: number
  seed: number
}>

type GraphLayout = Readonly<{
  hubA: Point
  hubB: Point
  inputs: readonly Point[]
  outputs: readonly Point[]
}>

export type FlowGraphData = Readonly<{
  /** Normalized composition coordinates. Map x/y to the active orthographic camera in the shader. */
  position: Float32Array
  normal: Float32Array
  progress: Float32Array
  reveal: Float32Array
  alpha: Float32Array
  layer: Float32Array
  seed: Float32Array
  /** Vertex count. Consecutive pairs form independent LineSegments. */
  count: number
}>

type AttributeLists = {
  alpha: number[]
  layer: number[]
  normal: number[]
  position: number[]
  progress: number[]
  reveal: number[]
  seed: number[]
}

const DESKTOP_LAYOUT: GraphLayout = {
  hubA: { x: 0.46, y: 0.62 },
  hubB: { x: 0.738, y: 0.335 },
  inputs: [
    { x: 0.1, y: 0.545 },
    { x: 0.12, y: 0.565 },
    { x: 0.14, y: 0.59 },
    { x: 0.16, y: 0.615 },
    { x: 0.18, y: 0.635 },
  ],
  outputs: [
    { x: 1.1, y: 0.11 },
    { x: 1.13, y: 0.2 },
    { x: 1.12, y: 0.3 },
    { x: 1.1, y: 0.4 },
    { x: 1.06, y: 0.51 },
  ],
}

const MOBILE_LAYOUT: GraphLayout = {
  hubA: { x: 0.63, y: 0.68 },
  hubB: { x: 0.69, y: 0.31 },
  inputs: [
    { x: 0.28, y: 1.12 },
    { x: 0.41, y: 1.08 },
    { x: 0.58, y: 1.1 },
    { x: 0.74, y: 1.05 },
  ],
  outputs: [
    { x: 0.67, y: -0.12 },
    { x: 0.82, y: -0.1 },
    { x: 0.97, y: -0.04 },
    { x: 1.08, y: 0.08 },
  ],
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum)

function random(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453123
  return value - Math.floor(value)
}

function signedRandom(seed: number): number {
  return random(seed) * 2 - 1
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount
}

function point(x: number, y: number): Point {
  return { x, y }
}

function jitter(source: Point, seed: number, amount: number): Point {
  return point(source.x + signedRandom(seed) * amount, source.y + signedRandom(seed + 1) * amount)
}

function midpoint(from: Point, to: Point, amount: number, normalOffset: number): Point {
  const x = mix(from.x, to.x, amount)
  const y = mix(from.y, to.y, amount)
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return point(
    x - ((to.y - from.y) / length) * normalOffset,
    y + ((to.x - from.x) / length) * normalOffset,
  )
}

function tangent(points: readonly Point[], index: number): Point {
  const previous = points[Math.max(0, index - 1)]!
  const next = points[Math.min(points.length - 1, index + 1)]!
  return point((next.x - previous.x) * 0.5, (next.y - previous.y) * 0.5)
}

function hermite(from: Point, to: Point, fromTangent: Point, toTangent: Point, t: number): Point {
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return point(
    h00 * from.x + h10 * fromTangent.x + h01 * to.x + h11 * toTangent.x,
    h00 * from.y + h10 * fromTangent.y + h01 * to.y + h11 * toTangent.y,
  )
}

/**
 * Samples a C1 Hermite route. This runs only while constructing static buffers;
 * the WebGL shader can add motion and pointer deformation to the result later.
 */
function sampleRoute(route: Route): Point[] {
  const result: Point[] = []
  const sections = route.anchors.length - 1
  for (let section = 0; section < sections; section += 1) {
    const from = route.anchors[section]!
    const to = route.anchors[section + 1]!
    const fromTangent = tangent(route.anchors, section)
    const toTangent = tangent(route.anchors, section + 1)
    for (let sample = 0; sample < route.samplesPerSection; sample += 1) {
      const localT = sample / route.samplesPerSection
      if (section > 0 && sample === 0) continue
      result.push(hermite(from, to, fromTangent, toTangent, localT))
    }
  }
  result.push(route.anchors[route.anchors.length - 1]!)
  return result
}

function makePrimaryRoutes(layout: GraphLayout, variant: FlowVariant, startSeed: number): Route[] {
  const count = variant === 'desktop' ? 12 : 9
  return Array.from({ length: count }, (_, index) => {
    const seed = startSeed + index * 13
    const input = layout.inputs[index % layout.inputs.length]!
    const output = layout.outputs[(index * 3) % layout.outputs.length]!
    const drift = signedRandom(seed + 2) * (variant === 'desktop' ? 0.045 : 0.055)
    const hubA = jitter(layout.hubA, seed + 3, 0.012)
    const hubB = jitter(layout.hubB, seed + 5, 0.025)
    return {
      alpha: 0.09 + random(seed + 7) * 0.12,
      anchors: [
        jitter(input, seed, variant === 'desktop' ? 0.025 : 0.045),
        midpoint(input, hubA, 0.5, drift),
        hubA,
        midpoint(hubA, hubB, 0.5, -drift * 0.45),
        hubB,
        midpoint(hubB, output, 0.48, drift * 0.65),
        jitter(output, seed + 9, 0.05),
      ],
      layer: 2,
      reveal: 0.04 + random(seed + 11) * 0.1,
      samplesPerSection: variant === 'desktop' ? 9 : 7,
      seed: random(seed + 12),
    }
  })
}

function makeTributaryRoutes(
  layout: GraphLayout,
  variant: FlowVariant,
  startSeed: number,
): Route[] {
  const count = variant === 'desktop' ? 12 : 7
  return Array.from({ length: count }, (_, index) => {
    const seed = startSeed + index * 17
    const input = layout.inputs[(index + 2) % layout.inputs.length]!
    const hubA = jitter(layout.hubA, seed + 3, 0.026)
    const hubB = jitter(layout.hubB, seed + 5, 0.04)
    const direction = index % 3
    const exit =
      direction === 0
        ? point(hubB.x + 0.21, hubB.y - 0.16)
        : direction === 1
          ? point(hubB.x + 0.28, hubB.y + 0.05)
          : point(hubB.x + 0.17, hubB.y + 0.2)
    return {
      alpha: 0.045 + random(seed + 7) * 0.075,
      anchors: [
        jitter(input, seed, variant === 'desktop' ? 0.035 : 0.07),
        midpoint(input, hubA, 0.6, signedRandom(seed + 1) * 0.075),
        hubA,
        midpoint(hubA, hubB, 0.58, signedRandom(seed + 2) * 0.045),
        hubB,
        jitter(exit, seed + 9, 0.07),
      ],
      layer: 1,
      reveal: 0.14 + random(seed + 11) * 0.15,
      samplesPerSection: variant === 'desktop' ? 7 : 6,
      seed: random(seed + 12),
    }
  })
}

function makeExitRoutes(layout: GraphLayout, variant: FlowVariant, startSeed: number): Route[] {
  const count = variant === 'desktop' ? 12 : 7
  return Array.from({ length: count }, (_, index) => {
    const seed = startSeed + index * 19
    const output = layout.outputs[index % layout.outputs.length]!
    const hubB = jitter(layout.hubB, seed + 1, 0.045)
    const branch = midpoint(hubB, output, 0.36, signedRandom(seed + 3) * 0.075)
    return {
      alpha: 0.04 + random(seed + 4) * 0.085,
      anchors: [
        point(layout.hubB.x - 0.1, layout.hubB.y + signedRandom(seed + 2) * 0.075),
        hubB,
        branch,
        jitter(output, seed + 5, 0.075),
      ],
      layer: 1,
      reveal: 0.3 + random(seed + 6) * 0.15,
      samplesPerSection: variant === 'desktop' ? 8 : 7,
      seed: random(seed + 7),
    }
  })
}

function makeBackgroundRoutes(
  layout: GraphLayout,
  variant: FlowVariant,
  startSeed: number,
): Route[] {
  const count = variant === 'desktop' ? 3 : 5
  return Array.from({ length: count }, (_, index) => {
    const seed = startSeed + index * 23
    const input = layout.inputs[index % layout.inputs.length]!
    const output = layout.outputs[(index + 1) % layout.outputs.length]!
    const upper = index % 2 === 0
    const sideA = point(
      mix(input.x, layout.hubA.x, 0.55),
      mix(input.y, layout.hubA.y, 0.55) + (upper ? -0.14 : 0.13) + signedRandom(seed) * 0.04,
    )
    const sideB = point(
      mix(layout.hubB.x, output.x, 0.38),
      mix(layout.hubB.y, output.y, 0.38) + (upper ? -0.13 : 0.13) + signedRandom(seed + 1) * 0.04,
    )
    return {
      alpha: 0.012 + random(seed + 2) * 0.024,
      anchors: [jitter(input, seed + 3, 0.09), sideA, sideB, jitter(output, seed + 4, 0.09)],
      layer: 0,
      reveal: 0.18 + random(seed + 5) * 0.3,
      samplesPerSection: variant === 'desktop' ? 7 : 6,
      seed: random(seed + 6),
    }
  })
}

function makeNetworkRoutes(layout: GraphLayout, variant: FlowVariant, startSeed: number): Route[] {
  const count = variant === 'desktop' ? 44 : 8
  return Array.from({ length: count }, (_, index) => {
    const seed = startSeed + index * 29
    const hub = index % 3 === 0 ? layout.hubB : layout.hubA
    const radius = 0.025 + random(seed) * 0.085
    const angleA = random(seed + 1) * Math.PI * 2
    const angleB = angleA + 0.45 + random(seed + 2) * 1.4
    const from = point(hub.x + Math.cos(angleA) * radius, hub.y + Math.sin(angleA) * radius)
    const to = point(hub.x + Math.cos(angleB) * radius, hub.y + Math.sin(angleB) * radius)
    const middle = midpoint(from, to, 0.5, signedRandom(seed + 3) * 0.025)
    return {
      alpha: 0.03 + random(seed + 4) * 0.045,
      anchors: [from, middle, to],
      layer: 0,
      reveal: 0.36 + random(seed + 5) * 0.25,
      samplesPerSection: 4,
      seed: random(seed + 6),
    }
  })
}

function routesFor(variant: FlowVariant): Route[] {
  const layout = variant === 'desktop' ? DESKTOP_LAYOUT : MOBILE_LAYOUT
  return [
    ...makePrimaryRoutes(layout, variant, 101),
    ...makeTributaryRoutes(layout, variant, 601),
    ...makeExitRoutes(layout, variant, 1201),
    ...makeBackgroundRoutes(layout, variant, 1801),
    ...makeNetworkRoutes(layout, variant, 2401),
  ]
}

function appendRoute(route: Route, attributes: AttributeLists) {
  const samples = sampleRoute(route)
  const denominator = Math.max(samples.length - 1, 1)
  for (let index = 1; index < samples.length; index += 1) {
    const from = samples[index - 1]!
    const to = samples[index]!
    const tangentX = to.x - from.x
    const tangentY = to.y - from.y
    const length = Math.hypot(tangentX, tangentY) || 1
    const normalX = -tangentY / length
    const normalY = tangentX / length
    const progressFrom = (index - 1) / denominator
    const progressTo = index / denominator
    const revealFrom = clamp(route.reveal + progressFrom * 0.7, 0, 1)
    const revealTo = clamp(route.reveal + progressTo * 0.7, 0, 1)

    attributes.position.push(from.x, from.y, route.layer * -0.08)
    attributes.position.push(to.x, to.y, route.layer * -0.08)
    attributes.normal.push(normalX, normalY, normalX, normalY)
    attributes.progress.push(progressFrom, progressTo)
    attributes.reveal.push(revealFrom, revealTo)
    attributes.alpha.push(route.alpha, route.alpha)
    attributes.layer.push(route.layer, route.layer)
    attributes.seed.push(route.seed, route.seed)
  }
}

/**
 * Produces an irregular, deterministic secondary flow network. The arrays are
 * intentionally free of Three.js so they can be shared by WebGL, SVG tooling,
 * and deterministic visual tests.
 */
export function createFlowGraphData(variant: FlowVariant): FlowGraphData {
  const attributes = {
    alpha: [] as number[],
    layer: [] as number[],
    normal: [] as number[],
    position: [] as number[],
    progress: [] as number[],
    reveal: [] as number[],
    seed: [] as number[],
  }

  for (const route of routesFor(variant)) appendRoute(route, attributes)

  const count = attributes.progress.length
  return {
    alpha: new Float32Array(attributes.alpha),
    count,
    layer: new Float32Array(attributes.layer),
    normal: new Float32Array(attributes.normal),
    position: new Float32Array(attributes.position),
    progress: new Float32Array(attributes.progress),
    reveal: new Float32Array(attributes.reveal),
    seed: new Float32Array(attributes.seed),
  }
}
