import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  LineSegments,
  OrthographicCamera,
  Points,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from 'three'
import type { IUniform } from 'three'

import { createFlowGraphData } from './flow-graph'
import { FLOW_BREAKS, FLOW_PATHS, FLOW_QUALITY, pathPoint } from './flow-model'
import type { FlowPath, FlowVariant } from './flow-model'

export type FlowFieldEngineOptions = Readonly<{
  container: HTMLDivElement
  onContextFailure: () => void
  onFirstFrame: () => void
}>

type Interaction = {
  activePointerId: number | null
  downAt: number
  downClientX: number
  downClientY: number
  downX: number
  downY: number
  isDragging: boolean
  pointerX: number
  pointerY: number
  targetX: number
  targetY: number
  velocityX: number
  velocityY: number
  x: number
  y: number
}

type Uniform = IUniform<unknown>

type FlowUniforms = {
  uAspect: Uniform
  uDrag: Uniform
  uDragOffset: Uniform
  uEntryA: Uniform
  uEntryB: Uniform
  uEnd: Uniform
  uExitA: Uniform
  uExitB: Uniform
  uMiddleA: Uniform
  uMiddleB: Uniform
  uNodeA: Uniform
  uNodeB: Uniform
  uPixelRatio: Uniform
  uPointer: Uniform
  uPulseA: Uniform
  uPulseB: Uniform
  uPulseC: Uniform
  uPulseD: Uniform
  uReveal: Uniform
  uStart: Uniform
  uTime: Uniform
}

type DrawRange = Readonly<{ count: number; start: number }>

const QUALITY_REDUCTION = 0.72

const SEGMENT_RANGES = createDrawRanges((variant) => {
  const quality = FLOW_QUALITY[variant]
  return quality.filaments * quality.segments * 2
})

const PARTICLE_RANGES = createDrawRanges((variant) => FLOW_QUALITY[variant].particles)

const BACKGROUND_COUNTS = { desktop: 150, mobile: 58 } as const
const BACKGROUND_RANGES = createDrawRanges((variant) => BACKGROUND_COUNTS[variant])
const NETWORK_NODE_COUNTS = { desktop: 58, mobile: 24 } as const
const NETWORK_NODE_RANGES = createDrawRanges((variant) => NETWORK_NODE_COUNTS[variant])
const NETWORK_EDGE_RANGES = createDrawRanges((variant) => (NETWORK_NODE_COUNTS[variant] - 2) * 2)
const NETWORK_HUBS = {
  desktop: [
    [0.46, 0.62],
    [0.738, 0.335],
  ],
  mobile: [
    [0.63, 0.68],
    [0.69, 0.31],
  ],
} as const
const FLOW_GRAPH = {
  mobile: createFlowGraphData('mobile'),
  desktop: createFlowGraphData('desktop'),
}
const GRAPH_RANGES: Record<FlowVariant, DrawRange> = {
  mobile: { count: FLOW_GRAPH.mobile.count, start: 0 },
  desktop: { count: FLOW_GRAPH.desktop.count, start: FLOW_GRAPH.mobile.count },
}

const FLOW_VERTEX_COMMON = `
uniform vec2 uStart;
uniform vec2 uEntryA;
uniform vec2 uEntryB;
uniform vec2 uNodeA;
uniform vec2 uMiddleA;
uniform vec2 uMiddleB;
uniform vec2 uNodeB;
uniform vec2 uExitA;
uniform vec2 uExitB;
uniform vec2 uEnd;
uniform vec2 uPointer;
uniform vec2 uDrag;
uniform vec2 uDragOffset;
uniform float uAspect;
uniform float uReveal;
uniform float uTime;
uniform vec3 uPulseA;
uniform vec3 uPulseB;
uniform vec3 uPulseC;
uniform vec3 uPulseD;

vec2 cubic(vec2 start, vec2 controlA, vec2 controlB, vec2 end, float t) {
  float i = 1.0 - t;
  return i*i*i*start + 3.0*i*i*t*controlA + 3.0*i*t*t*controlB + t*t*t*end;
}

vec2 cubicTangent(vec2 start, vec2 controlA, vec2 controlB, vec2 end, float t) {
  float i = 1.0 - t;
  return 3.0*i*i*(controlA-start) + 6.0*i*t*(controlB-controlA) + 3.0*t*t*(end-controlB);
}

vec2 curve(float t) {
  if (t < ${FLOW_BREAKS[0].toFixed(2)}) {
    return cubic(uStart, uEntryA, uEntryB, uNodeA, t / ${FLOW_BREAKS[0].toFixed(2)});
  }
  if (t < ${FLOW_BREAKS[1].toFixed(2)}) {
    return cubic(uNodeA, uMiddleA, uMiddleB, uNodeB,
      (t - ${FLOW_BREAKS[0].toFixed(2)}) / ${(FLOW_BREAKS[1] - FLOW_BREAKS[0]).toFixed(2)});
  }
  return cubic(uNodeB, uExitA, uExitB, uEnd,
    (t - ${FLOW_BREAKS[1].toFixed(2)}) / ${(1 - FLOW_BREAKS[1]).toFixed(2)});
}

vec2 tangent(float t) {
  if (t < ${FLOW_BREAKS[0].toFixed(2)}) {
    return cubicTangent(uStart, uEntryA, uEntryB, uNodeA, t / ${FLOW_BREAKS[0].toFixed(2)});
  }
  if (t < ${FLOW_BREAKS[1].toFixed(2)}) {
    return cubicTangent(uNodeA, uMiddleA, uMiddleB, uNodeB,
      (t - ${FLOW_BREAKS[0].toFixed(2)}) / ${(FLOW_BREAKS[1] - FLOW_BREAKS[0]).toFixed(2)});
  }
  return cubicTangent(uNodeB, uExitA, uExitB, uEnd,
    (t - ${FLOW_BREAKS[1].toFixed(2)}) / ${(1 - FLOW_BREAKS[1]).toFixed(2)});
}

vec2 screenNormal(float t) {
  vec2 direction = normalize(vec2(tangent(t).x * uAspect, tangent(t).y));
  return vec2(-direction.y / uAspect, direction.x);
}

float envelope(float t) {
  float base = 0.014
    + 0.095 * pow(sin(3.14159265 * t), 1.35)
    + 0.025 * (1.0 - smoothstep(0.0, 0.3, t))
    + 0.085 * smoothstep(0.7, 1.0, t);
  float firstPinch = exp(-pow((t - ${FLOW_BREAKS[0].toFixed(2)}) / 0.055, 2.0));
  float secondPinch = exp(-pow((t - ${FLOW_BREAKS[1].toFixed(2)}) / 0.05, 2.0));
  return base * (1.0 - firstPinch * 0.78) * (1.0 - secondPinch * 0.72);
}

float fieldDistance(vec2 delta) {
  return length(vec2(delta.x * uAspect, delta.y));
}

float revealTime(float t) {
  if (t < ${FLOW_BREAKS[0].toFixed(2)}) {
    return mix(0.42, 0.08, t / ${FLOW_BREAKS[0].toFixed(2)});
  }
  if (t < ${FLOW_BREAKS[1].toFixed(2)}) {
    return mix(0.08, 0.56,
      (t - ${FLOW_BREAKS[0].toFixed(2)}) / ${(FLOW_BREAKS[1] - FLOW_BREAKS[0]).toFixed(2)});
  }
  return mix(0.56, 0.94,
    (t - ${FLOW_BREAKS[1].toFixed(2)}) / ${(1 - FLOW_BREAKS[1]).toFixed(2)});
}

vec2 force(vec2 position, vec2 source, float amount) {
  vec2 delta = position - source;
  vec2 screenDelta = vec2(delta.x * uAspect, delta.y);
  float reach = 1.0 - smoothstep(0.0, 0.36, length(screenDelta));
  vec2 direction = normalize(screenDelta + vec2(0.0001));
  return vec2(direction.x / uAspect, direction.y) * reach * amount;
}

vec2 pull(vec2 position, vec2 source, vec2 offset) {
  float reach = 1.0 - smoothstep(0.0, 0.4, fieldDistance(position - source));
  return offset * reach * 0.78;
}

float pulse(vec2 position, vec3 pulseData) {
  float age = uTime - pulseData.z;
  return exp(-pow((fieldDistance(position - pulseData.xy) - age * 0.38) * 34.0, 2.0))
    * step(0.0, age) * step(age, 2.2);
}
`

const LINE_VERTEX_SHADER = `
attribute float aT;
attribute float aLane;
attribute float aPhase;
${FLOW_VERTEX_COMMON}
varying float vIntensity;
varying float vReveal;

void main() {
  vec2 p = curve(aT);
  vec2 normal = screenNormal(aT);
  float widthVariation = 0.82 + fract(sin(aPhase * 71.3) * 43758.5453) * 0.28;
  float ripple = sin(aT * 11.2 + aPhase) * 0.007;
  float slowDrift = sin(aT * (2.4 + widthVariation) * 3.14159265 + aPhase) * 0.011
    + sin(aT * 7.3 + aPhase * 1.7) * 0.004;
  float lineSeed = fract(sin(aPhase * 53.17) * 43758.5453) - 0.5;
  float irregular = step(0.68, fract(sin(aPhase * 29.71) * 43758.5453));
  float weave = irregular * sin(aT * (11.0 + abs(lineSeed) * 13.0) + aPhase * 2.3)
    * (0.016 + abs(lineSeed) * 0.032) * pow(sin(3.14159265 * aT), 1.4);
  float nodeCalm = 1.0
    - exp(-pow((aT - ${FLOW_BREAKS[0].toFixed(2)}) / 0.045, 2.0)) * 0.58
    - exp(-pow((aT - ${FLOW_BREAKS[1].toFixed(2)}) / 0.04, 2.0)) * 0.48;
  float nodeVariation = lineSeed * 0.012
    * (exp(-pow((aT - ${FLOW_BREAKS[0].toFixed(2)}) / 0.06, 2.0))
      + exp(-pow((aT - ${FLOW_BREAKS[1].toFixed(2)}) / 0.055, 2.0)));
  float exitVariation = lineSeed * 0.038 * smoothstep(${FLOW_BREAKS[1].toFixed(2)}, 1.0, aT);
  p += normal * (aLane * envelope(aT) * widthVariation + ripple + slowDrift * nodeCalm + weave
    + nodeVariation + exitVariation);
  p += normal * sin(aT * 8.0 + aPhase + uTime * 0.2) * 0.0055;
  p += force(p, uPointer, 0.028);
  p += pull(p, uDrag, uDragOffset);
  float pulseRing = pulse(p, uPulseA) + pulse(p, uPulseB) + pulse(p, uPulseC)
    + pulse(p, uPulseD);
  float nodeLight = exp(-pow((aT - ${FLOW_BREAKS[0].toFixed(2)}) / 0.012, 2.0)) * 0.9
    + exp(-pow((aT - ${FLOW_BREAKS[1].toFixed(2)}) / 0.011, 2.0)) * 1.05;
  float revealAt = revealTime(aT);
  float startAt = fract(sin(aPhase * 17.31) * 43758.5453) * 0.12;
  float foreground = step(0.8, fract(sin(aPhase * 43.17) * 43758.5453));
  float revealFront = exp(-pow((uReveal - revealAt) / 0.032, 2.0));
  float ignition = exp(-pow((uReveal - 0.09) / 0.055, 2.0))
    * exp(-pow((aT - ${FLOW_BREAKS[0].toFixed(2)}) / 0.018, 2.0));
  vReveal = smoothstep(revealAt - 0.025, revealAt + 0.018, uReveal)
    * mix(0.2, 1.0, smoothstep(0.0, 0.24, p.x))
    * smoothstep(startAt, startAt + 0.075, aT);
  vIntensity = 0.18 + 0.34 * (sin(aPhase * 5.1 + aT * 18.0) * 0.5 + 0.5)
    + foreground * 0.34 + nodeLight + revealFront * 1.35 + ignition * 1.5 + pulseRing;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, sin(aPhase) * 0.02, 1.0);
}
`

const LINE_FRAGMENT_SHADER = `
uniform float uOpacity;
varying float vIntensity;
varying float vReveal;
void main() {
  float light = clamp(vIntensity, 0.0, 1.0);
  vec3 color = mix(vec3(0.17, 0.33, 0.49), vec3(0.9, 0.95, 1.0), light);
  gl_FragColor = vec4(
    color,
    uOpacity * (0.44 + clamp(vIntensity, 0.0, 1.35) * 0.56) * vReveal
  );
}
`

const PARTICLE_VERTEX_SHADER = `
attribute float aT;
attribute float aLane;
attribute float aPhase;
attribute float aSpeed;
attribute float aDepth;
uniform float uPixelRatio;
${FLOW_VERTEX_COMMON}
varying float vAlpha;
varying float vDepth;
varying float vReveal;
void main() {
  float t = fract(aT + uTime * aSpeed);
  vec2 p = curve(t);
  vec2 normal = screenNormal(t);
  float widthVariation = 0.82 + fract(sin(aPhase * 71.3) * 43758.5453) * 0.28;
  float slowDrift = sin(t * (2.4 + widthVariation) * 3.14159265 + aPhase) * 0.011
    + sin(t * 7.3 + aPhase * 1.7) * 0.004;
  float lineSeed = fract(sin(aPhase * 53.17) * 43758.5453) - 0.5;
  float irregular = step(0.68, fract(sin(aPhase * 29.71) * 43758.5453));
  float weave = irregular * sin(t * (11.0 + abs(lineSeed) * 13.0) + aPhase * 2.3)
    * (0.016 + abs(lineSeed) * 0.032) * pow(sin(3.14159265 * t), 1.4);
  float nodeCalm = 1.0
    - exp(-pow((t - ${FLOW_BREAKS[0].toFixed(2)}) / 0.045, 2.0)) * 0.58
    - exp(-pow((t - ${FLOW_BREAKS[1].toFixed(2)}) / 0.04, 2.0)) * 0.48;
  float nodeVariation = lineSeed * 0.012
    * (exp(-pow((t - ${FLOW_BREAKS[0].toFixed(2)}) / 0.06, 2.0))
      + exp(-pow((t - ${FLOW_BREAKS[1].toFixed(2)}) / 0.055, 2.0)));
  float exitVariation = lineSeed * 0.038 * smoothstep(${FLOW_BREAKS[1].toFixed(2)}, 1.0, t);
  float depthSpread = 1.0 + pow(aDepth, 6.0) * 1.35;
  p += normal * (aLane * envelope(t) * widthVariation * depthSpread + weave
    + sin(t * 11.2 + aPhase) * 0.007 + slowDrift * nodeCalm
    + nodeVariation + exitVariation);
  p += normal * sin(t * 8.0 + aPhase + uTime * 0.2) * 0.0055;
  p += force(p, uPointer, 0.028);
  p += pull(p, uDrag, uDragOffset);
  float pulseRing = pulse(p, uPulseA) + pulse(p, uPulseB) + pulse(p, uPulseC)
    + pulse(p, uPulseD);
  vDepth = aDepth;
  float revealAt = revealTime(t);
  vReveal = smoothstep(revealAt + 0.035, revealAt + 0.11, uReveal);
  vAlpha = 0.24 + fract(sin(aPhase * 91.73) * 43758.5453) * 0.58 + pulseRing;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.05 + aDepth * 0.12, 1.0);
  gl_PointSize = (1.05 + vAlpha * 1.8 + pow(aDepth, 9.0) * 7.0) * uPixelRatio;
}
`

const PARTICLE_FRAGMENT_SHADER = `
varying float vAlpha;
varying float vDepth;
varying float vReveal;
void main() {
  float distance = length(gl_PointCoord - vec2(0.5));
  float alpha = smoothstep(0.5, 0.0, distance) * vAlpha
    * mix(0.9, 0.38, pow(vDepth, 9.0)) * vReveal;
  gl_FragColor = vec4(vec3(0.72, 0.88, 1.0), alpha);
}
`

const BACKGROUND_VERTEX_SHADER = `
attribute float aAlpha;
attribute float aPhase;
attribute float aSize;
uniform float uAspect;
uniform float uPixelRatio;
uniform float uReveal;
uniform float uTime;
uniform vec2 uPointer;
varying float vAlpha;

void main() {
  vec2 p = position.xy;
  p.y += sin(uTime * 0.12 + aPhase) * 0.0025;
  vec2 delta = p - uPointer;
  vec2 screenDelta = vec2(delta.x * uAspect, delta.y);
  float reach = 1.0 - smoothstep(0.0, 0.28, length(screenDelta));
  vec2 direction = normalize(screenDelta + vec2(0.0001));
  p += vec2(direction.x / uAspect, direction.y) * reach * 0.009;
  vAlpha = aAlpha * smoothstep(0.28, 0.86, uReveal);
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.35, 1.0);
  gl_PointSize = aSize * uPixelRatio;
}
`

const BACKGROUND_FRAGMENT_SHADER = `
varying float vAlpha;
void main() {
  float radius = length(gl_PointCoord - vec2(0.5));
  float core = smoothstep(0.5, 0.0, radius);
  float glow = exp(-radius * radius * 10.0);
  vec3 color = mix(vec3(0.58, 0.76, 0.91), vec3(0.94, 0.97, 1.0), smoothstep(0.35, 0.72, vAlpha));
  gl_FragColor = vec4(color, (core * 0.62 + glow * 0.38) * vAlpha);
}
`

const GRAPH_VERTEX_SHADER = `
attribute vec2 aNormal;
attribute float aProgress;
attribute float aReveal;
attribute float aAlpha;
attribute float aLayer;
attribute float aSeed;
uniform float uAspect;
uniform float uReveal;
uniform float uTime;
uniform vec2 uPointer;
uniform vec2 uDrag;
uniform vec2 uDragOffset;
uniform vec2 uNodeA;
varying float vAlpha;
varying float vLayer;
varying float vFront;

float fieldDistance(vec2 delta) {
  return length(vec2(delta.x * uAspect, delta.y));
}

vec2 force(vec2 position, vec2 source, float amount) {
  vec2 delta = position - source;
  vec2 screenDelta = vec2(delta.x * uAspect, delta.y);
  float reach = 1.0 - smoothstep(0.0, 0.38, length(screenDelta));
  vec2 direction = normalize(screenDelta + vec2(0.0001));
  return vec2(direction.x / uAspect, direction.y) * reach * amount;
}

void main() {
  vec2 p = position.xy;
  vec2 screenNormal = normalize(vec2(aNormal.x * uAspect, aNormal.y));
  vec2 normal = vec2(screenNormal.x / uAspect, screenNormal.y);
  float depthMotion = mix(0.006, 0.002, clamp(aLayer * 0.5, 0.0, 1.0));
  p += normal * sin(aProgress * (13.0 + aSeed * 9.0) + aSeed * 31.0 + uTime * 0.16)
    * depthMotion;
  p += force(p, uPointer, 0.018);
  float dragReach = 1.0 - smoothstep(0.0, 0.44, fieldDistance(p - uDrag));
  p += uDragOffset * dragReach * 0.64;
  float revealAt = 0.08 + fieldDistance(p - uNodeA) * 0.72 + aSeed * 0.025 + aReveal * 0.02;
  float revealAlpha = smoothstep(revealAt - 0.035, revealAt + 0.025, uReveal);
  vFront = exp(-pow((uReveal - revealAt) / 0.045, 2.0));
  float edgeFade = mix(0.18, 1.0, smoothstep(0.08, 0.32, p.x));
  vAlpha = aAlpha * revealAlpha * edgeFade * smoothstep(0.0, 0.1, aProgress)
    * mix(0.55, 1.0, clamp(aLayer * 0.5, 0.0, 1.0));
  vLayer = aLayer;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, position.z, 1.0);
}
`

const GRAPH_FRAGMENT_SHADER = `
varying float vAlpha;
varying float vLayer;
varying float vFront;
void main() {
  float layer = clamp(vLayer * 0.5, 0.0, 1.0);
  vec3 base = mix(vec3(0.07, 0.14, 0.22), vec3(0.3, 0.5, 0.67), layer);
  vec3 color = mix(base, vec3(0.8, 0.92, 1.0), vFront * 0.62);
  gl_FragColor = vec4(color, vAlpha * (0.7 + vFront * 0.55));
}
`

function seeded(index: number): number {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453123
  return value - Math.floor(value)
}

function networkNodePosition(variant: FlowVariant, index: number): readonly [number, number] {
  const hubs = NETWORK_HUBS[variant]
  if (index < 2) return hubs[index]!
  const isCoreCluster = index < 14
  const hubIndex = networkHubIndex(index)
  const hub = hubs[hubIndex]!
  const angle = seeded(index + (variant === 'mobile' ? 3101 : 3301)) * Math.PI * 2
  const radius = isCoreCluster
    ? 0.005 + seeded(index + 3401) * 0.018
    : 0.025 + Math.pow(seeded(index + 3401), 1.7) * 0.125
  const xScale = variant === 'mobile' ? 0.62 : 0.78
  return [hub[0] + Math.cos(angle) * radius * xScale, hub[1] + Math.sin(angle) * radius]
}

function networkHubIndex(index: number): 0 | 1 {
  if (index < 2) return index as 0 | 1
  if (index < 14) return ((index - 2) % 2) as 0 | 1
  return index % 3 === 0 ? 0 : 1
}

function createDrawRanges(
  getCount: (variant: FlowVariant) => number,
): Record<FlowVariant, DrawRange> {
  const mobileCount = getCount('mobile')
  return {
    mobile: { count: mobileCount, start: 0 },
    desktop: { count: getCount('desktop'), start: mobileCount },
  }
}

function toField(event: PointerEvent, canvas: HTMLCanvasElement): readonly [number, number] {
  const rect = canvas.getBoundingClientRect()
  return [
    (event.clientX - rect.left) / Math.max(1, rect.width),
    (event.clientY - rect.top) / Math.max(1, rect.height),
  ]
}

const pointValue = (value: { x: number; y: number }) => [value.x, value.y]

function setPathUniforms(uniforms: FlowUniforms, path: FlowPath) {
  const [entry, middle, exit] = path
  uniforms.uStart.value = pointValue(entry.start)
  uniforms.uEntryA.value = pointValue(entry.controlA)
  uniforms.uEntryB.value = pointValue(entry.controlB)
  uniforms.uNodeA.value = pointValue(entry.end)
  uniforms.uMiddleA.value = pointValue(middle.controlA)
  uniforms.uMiddleB.value = pointValue(middle.controlB)
  uniforms.uNodeB.value = pointValue(middle.end)
  uniforms.uExitA.value = pointValue(exit.controlA)
  uniforms.uExitB.value = pointValue(exit.controlB)
  uniforms.uEnd.value = pointValue(exit.end)
}

/** A deterministic GPU-drawn field with no React state on its animation path. */
export class FlowFieldEngine {
  private animationFrame = 0
  private backgroundGeometry: BufferGeometry
  private backgroundMaterial: ShaderMaterial
  private camera: OrthographicCamera
  private canvas: HTMLCanvasElement
  private contextLost = false
  private disposed = false
  private firstFrame = true
  private frameDurationTotal = 0
  private frameSampleCount = 0
  private graphGeometry: BufferGeometry
  private graphMaterial: ShaderMaterial
  private height = 1
  private isDocumentHidden = false
  private lastFrameAt = performance.now()
  private lineMaterial: ShaderMaterial
  private networkEdgeGeometry: BufferGeometry
  private networkNodeGeometry: BufferGeometry
  private networkNodeMaterial: ShaderMaterial
  private particleMaterial: ShaderMaterial
  private particleGeometry: BufferGeometry
  private pulseCursor = 0
  private revealStartedAt = 0
  private reducedQuality = false
  private renderer: WebGLRenderer
  private scene: Scene
  private segmentGeometry: BufferGeometry
  private uniforms: FlowUniforms
  private variant: FlowVariant = 'desktop'
  private width = 1
  private qualitySampleStartedAt = performance.now()
  private interaction: Interaction = {
    activePointerId: null,
    downAt: 0,
    downClientX: 0,
    downClientY: 0,
    downX: 0,
    downY: 0,
    isDragging: false,
    pointerX: 10,
    pointerY: 10,
    targetX: 10,
    targetY: 10,
    velocityX: 0,
    velocityY: 0,
    x: 10,
    y: 10,
  }
  private readonly onContextFailure: () => void
  private readonly onFirstFrame: () => void
  constructor({ container, onContextFailure, onFirstFrame }: FlowFieldEngineOptions) {
    this.onContextFailure = onContextFailure
    this.onFirstFrame = onFirstFrame
    this.isDocumentHidden = document.hidden

    this.renderer = new WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.canvas = this.renderer.domElement
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.className = 'block h-full w-full [touch-action:pan-y_pinch-zoom]'
    container.append(this.canvas)

    this.scene = new Scene()
    this.camera = new OrthographicCamera(-1, 1, 1, -1, -1, 1)
    this.uniforms = {
      uStart: { value: [0, 0] },
      uEntryA: { value: [0, 0] },
      uEntryB: { value: [0, 0] },
      uNodeA: { value: [0, 0] },
      uMiddleA: { value: [0, 0] },
      uMiddleB: { value: [0, 0] },
      uNodeB: { value: [0, 0] },
      uExitA: { value: [0, 0] },
      uExitB: { value: [0, 0] },
      uEnd: { value: [0, 0] },
      uAspect: { value: 1 },
      uPixelRatio: { value: 1 },
      uPointer: { value: [10, 10] },
      uDrag: { value: [10, 10] },
      uDragOffset: { value: [0, 0] },
      uPulseA: { value: [10, 10, -10] },
      uPulseB: { value: [10, 10, -10] },
      uPulseC: { value: [10, 10, -10] },
      uPulseD: { value: [10, 10, -10] },
      uReveal: { value: 0 },
      uTime: { value: 0 },
    }

    this.graphGeometry = this.createGraph()
    this.graphMaterial = new ShaderMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      fragmentShader: GRAPH_FRAGMENT_SHADER,
      transparent: true,
      uniforms: this.uniforms,
      vertexShader: GRAPH_VERTEX_SHADER,
    })
    this.scene.add(new LineSegments(this.graphGeometry, this.graphMaterial))

    this.networkEdgeGeometry = this.createNetworkEdges()
    this.scene.add(new LineSegments(this.networkEdgeGeometry, this.graphMaterial))

    this.segmentGeometry = this.createSegments()
    this.lineMaterial = new ShaderMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      fragmentShader: LINE_FRAGMENT_SHADER,
      transparent: true,
      uniforms: { ...this.uniforms, uOpacity: { value: 0.235 } },
      vertexShader: LINE_VERTEX_SHADER,
    })
    this.scene.add(new LineSegments(this.segmentGeometry, this.lineMaterial))

    this.particleGeometry = this.createParticles()
    this.particleMaterial = new ShaderMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      transparent: true,
      uniforms: this.uniforms,
      vertexShader: PARTICLE_VERTEX_SHADER,
    })
    this.scene.add(new Points(this.particleGeometry, this.particleMaterial))

    this.backgroundGeometry = this.createBackgroundParticles()
    this.backgroundMaterial = new ShaderMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      fragmentShader: BACKGROUND_FRAGMENT_SHADER,
      transparent: true,
      uniforms: this.uniforms,
      vertexShader: BACKGROUND_VERTEX_SHADER,
    })
    this.scene.add(new Points(this.backgroundGeometry, this.backgroundMaterial))

    this.networkNodeGeometry = this.createNetworkNodes()
    this.networkNodeMaterial = new ShaderMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      fragmentShader: BACKGROUND_FRAGMENT_SHADER,
      transparent: true,
      uniforms: this.uniforms,
      vertexShader: BACKGROUND_VERTEX_SHADER,
    })
    this.scene.add(new Points(this.networkNodeGeometry, this.networkNodeMaterial))

    this.canvas.addEventListener('pointerdown', this.handlePointerDown)
    this.canvas.addEventListener('pointermove', this.handlePointerMove)
    this.canvas.addEventListener('pointerup', this.handlePointerUp)
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel)
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave)
    this.canvas.addEventListener('lostpointercapture', this.handlePointerCancel)
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.resize()
    this.updateAnimationLoop()
  }

  private createSegments(): BufferGeometry {
    const geometry = new BufferGeometry()
    const vertexCount = SEGMENT_RANGES.desktop.start + SEGMENT_RANGES.desktop.count
    const t = new Float32Array(vertexCount)
    const lane = new Float32Array(vertexCount)
    const phase = new Float32Array(vertexCount)
    let cursor = 0
    for (const variant of ['mobile', 'desktop'] as const) {
      const quality = FLOW_QUALITY[variant]
      const bundleSize = variant === 'desktop' ? 4 : 3
      const bundleCount = Math.ceil(quality.filaments / bundleSize)
      for (let filament = 0; filament < quality.filaments; filament += 1) {
        const bundle = Math.floor(filament / bundleSize)
        const withinBundle = filament % bundleSize
        const bundleCenter = (bundle / Math.max(1, bundleCount - 1)) * 2 - 1
        const intraBundle =
          (withinBundle - (bundleSize - 1) * 0.5) * 0.075 + (seeded(filament + 37) - 0.5) * 0.035
        const normalizedLane = Math.max(-1, Math.min(1, bundleCenter + intraBundle))
        const filamentPhase = seeded(filament + 3) * Math.PI * 2
        for (let segment = 0; segment < quality.segments; segment += 1) {
          const before = segment / quality.segments
          const after = (segment + 1) / quality.segments
          t[cursor] = before
          lane[cursor] = normalizedLane
          phase[cursor] = filamentPhase
          cursor += 1
          t[cursor] = after
          lane[cursor] = normalizedLane
          phase[cursor] = filamentPhase
          cursor += 1
        }
      }
    }
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertexCount * 3), 3))
    geometry.setAttribute('aT', new BufferAttribute(t, 1))
    geometry.setAttribute('aLane', new BufferAttribute(lane, 1))
    geometry.setAttribute('aPhase', new BufferAttribute(phase, 1))
    geometry.setDrawRange(0, vertexCount)
    return geometry
  }

  private createGraph(): BufferGeometry {
    const geometry = new BufferGeometry()
    const totalCount = FLOW_GRAPH.mobile.count + FLOW_GRAPH.desktop.count

    const merge = (name: keyof Omit<(typeof FLOW_GRAPH)['desktop'], 'count'>, itemSize: number) => {
      const mobile = FLOW_GRAPH.mobile[name]
      const desktop = FLOW_GRAPH.desktop[name]
      const values = new Float32Array(mobile.length + desktop.length)
      values.set(mobile)
      values.set(desktop, mobile.length)
      geometry.setAttribute(
        name === 'position' ? name : `a${name[0]!.toUpperCase()}${name.slice(1)}`,
        new BufferAttribute(values, itemSize),
      )
    }

    merge('position', 3)
    merge('normal', 2)
    merge('progress', 1)
    merge('reveal', 1)
    merge('alpha', 1)
    merge('layer', 1)
    merge('seed', 1)
    geometry.setDrawRange(0, totalCount)
    return geometry
  }

  private createNetworkEdges(): BufferGeometry {
    const geometry = new BufferGeometry()
    const count = NETWORK_EDGE_RANGES.desktop.start + NETWORK_EDGE_RANGES.desktop.count
    const position = new Float32Array(count * 3)
    const normal = new Float32Array(count * 2)
    const progress = new Float32Array(count)
    const reveal = new Float32Array(count)
    const alpha = new Float32Array(count)
    const layer = new Float32Array(count)
    const seed = new Float32Array(count)
    let cursor = 0

    for (const variant of ['mobile', 'desktop'] as const) {
      for (let index = 2; index < NETWORK_NODE_COUNTS[variant]; index += 1) {
        const hubIndex = networkHubIndex(index)
        const from = networkNodePosition(variant, index)
        const hub = networkNodePosition(variant, hubIndex)
        const linkAmount = 0.38 + seeded(index + 4001) * 0.32
        const tangentXToHub = hub[0] - from[0]
        const tangentYToHub = hub[1] - from[1]
        const tangentLengthToHub = Math.hypot(tangentXToHub, tangentYToHub) || 1
        const side = (seeded(index + 4051) - 0.5) * 0.022
        const target = [
          from[0] + tangentXToHub * linkAmount - (tangentYToHub / tangentLengthToHub) * side,
          from[1] + tangentYToHub * linkAmount + (tangentXToHub / tangentLengthToHub) * side,
        ] as const
        const tangentX = target[0] - from[0]
        const tangentY = target[1] - from[1]
        const tangentLength = Math.hypot(tangentX, tangentY) || 1
        const edgeAlpha = 0.024 + seeded(index + 4101) * 0.052
        const edgeReveal = 0.32 + seeded(index + 4201) * 0.42
        const edgeSeed = seeded(index + 4301)

        for (const [point, value] of [
          [from, 0],
          [target, 1],
        ] as const) {
          position[cursor * 3] = point[0]
          position[cursor * 3 + 1] = point[1]
          position[cursor * 3 + 2] = 0.02
          normal[cursor * 2] = -tangentY / tangentLength
          normal[cursor * 2 + 1] = tangentX / tangentLength
          progress[cursor] = value
          reveal[cursor] = edgeReveal
          alpha[cursor] = edgeAlpha
          layer[cursor] = 0.35
          seed[cursor] = edgeSeed
          cursor += 1
        }
      }
    }

    geometry.setAttribute('position', new BufferAttribute(position, 3))
    geometry.setAttribute('aNormal', new BufferAttribute(normal, 2))
    geometry.setAttribute('aProgress', new BufferAttribute(progress, 1))
    geometry.setAttribute('aReveal', new BufferAttribute(reveal, 1))
    geometry.setAttribute('aAlpha', new BufferAttribute(alpha, 1))
    geometry.setAttribute('aLayer', new BufferAttribute(layer, 1))
    geometry.setAttribute('aSeed', new BufferAttribute(seed, 1))
    geometry.setDrawRange(0, count)
    return geometry
  }

  private createParticles(): BufferGeometry {
    const geometry = new BufferGeometry()
    const count = PARTICLE_RANGES.desktop.start + PARTICLE_RANGES.desktop.count
    const t = new Float32Array(count)
    const lane = new Float32Array(count)
    const phase = new Float32Array(count)
    const speed = new Float32Array(count)
    const depth = new Float32Array(count)
    for (let index = 0; index < count; index += 1) {
      t[index] = seeded(index + 101)
      lane[index] = seeded(index + 211) * 2 - 1
      phase[index] = seeded(index + 307) * Math.PI * 2
      speed[index] = 0.008 + seeded(index + 401) * 0.02
      depth[index] = seeded(index + 503)
    }
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
    geometry.setAttribute('aT', new BufferAttribute(t, 1))
    geometry.setAttribute('aLane', new BufferAttribute(lane, 1))
    geometry.setAttribute('aPhase', new BufferAttribute(phase, 1))
    geometry.setAttribute('aSpeed', new BufferAttribute(speed, 1))
    geometry.setAttribute('aDepth', new BufferAttribute(depth, 1))
    geometry.setDrawRange(0, count)
    return geometry
  }

  private createBackgroundParticles(): BufferGeometry {
    const geometry = new BufferGeometry()
    const count = BACKGROUND_RANGES.desktop.start + BACKGROUND_RANGES.desktop.count
    const position = new Float32Array(count * 3)
    const alpha = new Float32Array(count)
    const phase = new Float32Array(count)
    const size = new Float32Array(count)
    let cursor = 0

    for (const variant of ['mobile', 'desktop'] as const) {
      const variantCount = BACKGROUND_COUNTS[variant]
      for (let index = 0; index < variantCount; index += 1) {
        const alongFlow = seeded(index + (variant === 'mobile' ? 1301 : 1701)) < 0.76
        let x: number
        let y: number

        if (alongFlow) {
          const t = seeded(index + 1801)
          const point = pathPoint(FLOW_PATHS[variant], t)
          x = point.x + (seeded(index + 1901) - 0.5) * (variant === 'mobile' ? 0.38 : 0.22)
          y = point.y + (seeded(index + 2001) - 0.5) * (variant === 'mobile' ? 0.34 : 0.42)
        } else {
          x = (variant === 'mobile' ? 0.42 : 0.34) + seeded(index + 2101) * 0.76
          y = 0.05 + seeded(index + 2201) * 0.9
        }

        position[cursor * 3] = x
        position[cursor * 3 + 1] = y
        position[cursor * 3 + 2] = 0.35
        const depth = seeded(index + 2301)
        const detailSeed = seeded(index + 2701)
        const isBokeh = detailSeed > 0.95
        const isSoft = detailSeed > 0.82 && !isBokeh
        const isHighlight = detailSeed > 0.72 && !isSoft && !isBokeh
        alpha[cursor] = isBokeh
          ? 0.02 + seeded(index + 2401) * 0.06
          : isSoft
            ? 0.04 + seeded(index + 2401) * 0.06
            : isHighlight
              ? 0.42 + seeded(index + 2401) * 0.38
              : 0.055 + seeded(index + 2401) * 0.25
        phase[cursor] = seeded(index + 2501) * Math.PI * 2
        size[cursor] = isBokeh
          ? 45 + seeded(index + 2601) * 45
          : isSoft
            ? 12 + seeded(index + 2601) * 23
            : isHighlight
              ? 1.5 + seeded(index + 2601) * 2.5
              : 0.8 + seeded(index + 2601) * 3.4 + Math.pow(depth, 9) * 5
        cursor += 1
      }
    }

    geometry.setAttribute('position', new BufferAttribute(position, 3))
    geometry.setAttribute('aAlpha', new BufferAttribute(alpha, 1))
    geometry.setAttribute('aPhase', new BufferAttribute(phase, 1))
    geometry.setAttribute('aSize', new BufferAttribute(size, 1))
    geometry.setDrawRange(0, count)
    return geometry
  }

  private createNetworkNodes(): BufferGeometry {
    const geometry = new BufferGeometry()
    const count = NETWORK_NODE_RANGES.desktop.start + NETWORK_NODE_RANGES.desktop.count
    const position = new Float32Array(count * 3)
    const alpha = new Float32Array(count)
    const phase = new Float32Array(count)
    const size = new Float32Array(count)
    let cursor = 0

    for (const variant of ['mobile', 'desktop'] as const) {
      const variantCount = NETWORK_NODE_COUNTS[variant]
      for (let index = 0; index < variantCount; index += 1) {
        const point = networkNodePosition(variant, index)
        const isHub = index < 2
        const isCore = index < 14
        position[cursor * 3] = point[0]
        position[cursor * 3 + 1] = point[1]
        position[cursor * 3 + 2] = -0.04
        alpha[cursor] = isCore
          ? 0.7 + seeded(index + 3501) * 0.3
          : 0.18 + seeded(index + 3501) * 0.42
        phase[cursor] = seeded(index + 3601) * Math.PI * 2
        size[cursor] = isHub
          ? index === 0
            ? 10.5
            : 12
          : isCore
            ? 2.2 + seeded(index + 3701) * 3.6
            : 1.2 + seeded(index + 3701) * 3.2
        cursor += 1
      }
    }

    geometry.setAttribute('position', new BufferAttribute(position, 3))
    geometry.setAttribute('aAlpha', new BufferAttribute(alpha, 1))
    geometry.setAttribute('aPhase', new BufferAttribute(phase, 1))
    geometry.setAttribute('aSize', new BufferAttribute(size, 1))
    geometry.setDrawRange(0, count)
    return geometry
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (this.interaction.activePointerId !== null || event.button !== 0) return
    const [x, y] = toField(event, this.canvas)
    this.interaction.activePointerId = event.pointerId
    this.interaction.downAt = event.timeStamp
    this.interaction.downClientX = event.clientX
    this.interaction.downClientY = event.clientY
    this.interaction.downX = x
    this.interaction.downY = y
    this.interaction.pointerX = x
    this.interaction.pointerY = y
    this.interaction.targetX = x
    this.interaction.targetY = y
    this.interaction.x = x
    this.interaction.y = y
    this.interaction.velocityX = 0
    this.interaction.velocityY = 0
    this.interaction.isDragging = false
  }

  private handlePointerMove = (event: PointerEvent) => {
    const [x, y] = toField(event, this.canvas)
    if (
      this.interaction.activePointerId !== null &&
      event.pointerId !== this.interaction.activePointerId
    )
      return

    this.interaction.pointerX = x
    this.interaction.pointerY = y
    if (this.interaction.activePointerId === null) return

    const distance = Math.hypot(
      event.clientX - this.interaction.downClientX,
      event.clientY - this.interaction.downClientY,
    )
    if (distance > 8 && !this.interaction.isDragging) {
      this.interaction.isDragging = true
      this.canvas.setPointerCapture(event.pointerId)
    }
    if (this.interaction.isDragging) {
      this.interaction.targetX = x
      this.interaction.targetY = y
    }
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.interaction.activePointerId) return
    const [x, y] = toField(event, this.canvas)
    const isShortClick =
      !this.interaction.isDragging && event.timeStamp - this.interaction.downAt < 350
    if (isShortClick) this.addPulse(x, y)
    this.endPointer(event.pointerId)
  }

  private handlePointerCancel = (event: PointerEvent) => {
    if (event.pointerId === this.interaction.activePointerId) this.endPointer(event.pointerId)
  }

  private handlePointerLeave = () => {
    if (this.interaction.activePointerId === null) {
      this.interaction.pointerX = 10
      this.interaction.pointerY = 10
    }
  }

  private endPointer(pointerId: number) {
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId)
    this.interaction.activePointerId = null
    this.interaction.isDragging = false
    this.interaction.targetX = this.interaction.downX
    this.interaction.targetY = this.interaction.downY
  }

  private addPulse(x: number, y: number) {
    const slots = ['uPulseA', 'uPulseB', 'uPulseC', 'uPulseD'] as const
    const slot = slots[this.pulseCursor] ?? 'uPulseA'
    this.uniforms[slot].value = [x, y, performance.now() / 1000]
    this.pulseCursor = (this.pulseCursor + 1) % slots.length
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault()
    this.contextLost = true
    this.onContextFailure()
    this.dispose()
  }

  private handleVisibilityChange = () => {
    this.isDocumentHidden = document.hidden
    this.updateAnimationLoop()
  }

  private updateAnimationLoop() {
    if (this.isDocumentHidden) {
      cancelAnimationFrame(this.animationFrame)
      this.animationFrame = 0
      return
    }
    if (!this.disposed && this.animationFrame === 0) {
      this.lastFrameAt = performance.now()
      this.animationFrame = requestAnimationFrame(this.render)
    }
  }

  resize = () => {
    if (this.disposed) return
    const rect = this.canvas.getBoundingClientRect()
    this.width = Math.max(1, rect.width)
    this.height = Math.max(1, rect.height)
    const aspect = this.width / this.height
    this.variant = this.width < 768 ? 'mobile' : 'desktop'
    const quality = FLOW_QUALITY[this.variant]
    const pixelRatioScale = this.reducedQuality ? 0.75 : 1
    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      quality.maxPixelRatio * pixelRatioScale,
    )
    this.renderer.setPixelRatio(pixelRatio)
    this.renderer.setSize(this.width, this.height, false)
    setPathUniforms(this.uniforms, FLOW_PATHS[this.variant])
    this.uniforms.uAspect.value = aspect
    this.uniforms.uPixelRatio.value = pixelRatio
    this.applyDrawRanges()
  }

  private applyDrawRanges() {
    const quality = FLOW_QUALITY[this.variant]
    const segmentRange = SEGMENT_RANGES[this.variant]
    const particleRange = PARTICLE_RANGES[this.variant]
    const backgroundRange = BACKGROUND_RANGES[this.variant]
    const graphRange = GRAPH_RANGES[this.variant]
    const networkEdgeRange = NETWORK_EDGE_RANGES[this.variant]
    const networkNodeRange = NETWORK_NODE_RANGES[this.variant]
    const scale = this.reducedQuality ? QUALITY_REDUCTION : 1
    const filamentCount = Math.max(1, Math.floor(quality.filaments * scale))

    this.segmentGeometry.setDrawRange(segmentRange.start, filamentCount * quality.segments * 2)
    this.particleGeometry.setDrawRange(
      particleRange.start,
      Math.max(1, Math.floor(particleRange.count * scale)),
    )
    this.backgroundGeometry.setDrawRange(
      backgroundRange.start,
      Math.max(1, Math.floor(backgroundRange.count * scale)),
    )
    this.graphGeometry.setDrawRange(
      graphRange.start,
      Math.max(2, Math.floor((graphRange.count * scale) / 2) * 2),
    )
    this.networkEdgeGeometry.setDrawRange(
      networkEdgeRange.start,
      Math.max(2, Math.floor((networkEdgeRange.count * scale) / 2) * 2),
    )
    this.networkNodeGeometry.setDrawRange(
      networkNodeRange.start,
      Math.max(2, Math.floor(networkNodeRange.count * scale)),
    )
  }

  private samplePerformance(now: number, frameDuration: number) {
    if (this.reducedQuality || frameDuration <= 0 || frameDuration > 100) return
    this.frameDurationTotal += frameDuration
    this.frameSampleCount += 1
    if (now - this.qualitySampleStartedAt < 3000 || this.frameSampleCount < 60) return

    if (this.frameDurationTotal / this.frameSampleCount > 25) {
      this.reducedQuality = true
      this.resize()
    }
  }

  private updateInteraction(delta: number) {
    const interaction = this.interaction
    // Critically damped spring: direct under the pointer, quiet and no visible bounce on release.
    const stiffness = interaction.isDragging ? 120 : 36
    const damping = 2 * Math.sqrt(stiffness)
    interaction.velocityX +=
      (stiffness * (interaction.targetX - interaction.x) - damping * interaction.velocityX) * delta
    interaction.velocityY +=
      (stiffness * (interaction.targetY - interaction.y) - damping * interaction.velocityY) * delta
    interaction.x += interaction.velocityX * delta
    interaction.y += interaction.velocityY * delta
    if (
      !interaction.isDragging &&
      Math.hypot(interaction.x - interaction.downX, interaction.y - interaction.downY) < 0.002
    ) {
      interaction.x = interaction.downX
      interaction.y = interaction.downY
      interaction.velocityX = 0
      interaction.velocityY = 0
    }
    this.uniforms.uPointer.value = [interaction.pointerX, interaction.pointerY]
    this.uniforms.uDrag.value = [interaction.downX, interaction.downY]
    const offsetX = interaction.x - interaction.downX
    const offsetY = interaction.y - interaction.downY
    const offsetLength = Math.hypot(offsetX * (this.width / this.height), offsetY)
    const offsetScale = offsetLength > 0.36 ? 0.36 / offsetLength : 1
    this.uniforms.uDragOffset.value = [offsetX * offsetScale, offsetY * offsetScale]
  }

  private render = (now: number) => {
    if (this.disposed || this.isDocumentHidden || this.contextLost) return
    const frameDuration = now - this.lastFrameAt
    const delta = Math.min(frameDuration / 1000, 0.05)
    this.lastFrameAt = now
    this.samplePerformance(now, frameDuration)
    this.updateInteraction(delta)
    this.uniforms.uTime.value = now / 1000
    if (this.revealStartedAt === 0) this.revealStartedAt = now
    this.uniforms.uReveal.value = Math.min(1, (now - this.revealStartedAt) / 1650)
    this.renderer.render(this.scene, this.camera)
    if (this.firstFrame) {
      this.firstFrame = false
      this.onFirstFrame()
    }
    this.animationFrame = requestAnimationFrame(this.render)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.animationFrame)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown)
    this.canvas.removeEventListener('pointermove', this.handlePointerMove)
    this.canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel)
    this.canvas.removeEventListener('pointerleave', this.handlePointerLeave)
    this.canvas.removeEventListener('lostpointercapture', this.handlePointerCancel)
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost)
    this.segmentGeometry.dispose()
    this.backgroundGeometry.dispose()
    this.graphGeometry.dispose()
    this.networkEdgeGeometry.dispose()
    this.networkNodeGeometry.dispose()
    this.particleGeometry.dispose()
    this.lineMaterial.dispose()
    this.backgroundMaterial.dispose()
    this.graphMaterial.dispose()
    this.networkNodeMaterial.dispose()
    this.particleMaterial.dispose()
    this.renderer.dispose()
    this.canvas.remove()
  }
}
