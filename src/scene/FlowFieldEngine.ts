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

import { FLOW_CURVES, FLOW_QUALITY } from './flow-model'
import type { FlowCurve, FlowVariant } from './flow-model'

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
  uControlA: Uniform
  uControlB: Uniform
  uDrag: Uniform
  uDragOffset: Uniform
  uEnd: Uniform
  uPointer: Uniform
  uPulseA: Uniform
  uPulseB: Uniform
  uPulseC: Uniform
  uPulseD: Uniform
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

const CONNECTION_RANGES = createDrawRanges((variant) => FLOW_QUALITY[variant].connections * 2)

const LINE_VERTEX_SHADER = `
attribute float aT;
attribute float aLane;
attribute float aPhase;
uniform vec2 uStart;
uniform vec2 uControlA;
uniform vec2 uControlB;
uniform vec2 uEnd;
uniform vec2 uPointer;
uniform vec2 uDrag;
uniform vec2 uDragOffset;
uniform float uTime;
uniform vec3 uPulseA;
uniform vec3 uPulseB;
uniform vec3 uPulseC;
uniform vec3 uPulseD;
varying float vIntensity;

vec2 curve(float t) {
  float i = 1.0 - t;
  return i*i*i*uStart + 3.0*i*i*t*uControlA + 3.0*i*t*t*uControlB + t*t*t*uEnd;
}

vec2 tangent(float t) {
  float i = 1.0 - t;
  return 3.0*i*i*(uControlA-uStart) + 6.0*i*t*(uControlB-uControlA) + 3.0*t*t*(uEnd-uControlB);
}

vec2 force(vec2 position, vec2 source, float amount) {
  vec2 offset = position - source;
  float distance = length(offset);
  float reach = 1.0 - smoothstep(0.0, 0.72, distance);
  return normalize(offset + vec2(0.0001)) * reach * amount;
}

vec2 pull(vec2 position, vec2 source, vec2 offset) {
  float reach = 1.0 - smoothstep(0.0, 0.72, length(position - source));
  return offset * reach * 0.82;
}

float pulse(vec2 position, vec3 pulseData) {
  float age = uTime - pulseData.z;
  return exp(-pow((length(position - pulseData.xy) - age * 0.82) * 17.0, 2.0))
    * step(0.0, age) * step(age, 2.8);
}

void main() {
  vec2 p = curve(aT);
  vec2 direction = normalize(tangent(aT));
  vec2 normal = vec2(-direction.y, direction.x);
  float envelope = 0.055 + 0.22 * pow(sin(3.14159265 * aT), 1.4);
  float ripple = sin(aT * 10.4 + aPhase) * 0.012;
  p += normal * (aLane * envelope + ripple);
  p += normal * sin(aT * 8.0 + aPhase + uTime * 0.25) * 0.011;
  p += force(p, uPointer, 0.05);
  p += pull(p, uDrag, uDragOffset);
  float pulseRing = pulse(p, uPulseA) + pulse(p, uPulseB) + pulse(p, uPulseC)
    + pulse(p, uPulseD);
  vIntensity = 0.42 + 0.58 * sin(aPhase * 5.1 + aT * 18.0) * 0.5 + 0.29 + pulseRing;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, sin(aPhase) * 0.02, 1.0);
}
`

const LINE_FRAGMENT_SHADER = `
uniform float uOpacity;
varying float vIntensity;
void main() {
  vec3 color = mix(vec3(0.16, 0.43, 0.72), vec3(0.77, 0.9, 1.0), vIntensity);
  gl_FragColor = vec4(color, uOpacity * (0.48 + vIntensity * 0.52));
}
`

const PARTICLE_VERTEX_SHADER = `
attribute float aT;
attribute float aLane;
attribute float aPhase;
attribute float aSpeed;
uniform vec2 uStart;
uniform vec2 uControlA;
uniform vec2 uControlB;
uniform vec2 uEnd;
uniform vec2 uPointer;
uniform vec2 uDrag;
uniform vec2 uDragOffset;
uniform float uTime;
uniform vec3 uPulseA;
uniform vec3 uPulseB;
uniform vec3 uPulseC;
uniform vec3 uPulseD;
varying float vAlpha;

vec2 curve(float t) {
  float i = 1.0 - t;
  return i*i*i*uStart + 3.0*i*i*t*uControlA + 3.0*i*t*t*uControlB + t*t*t*uEnd;
}
vec2 tangent(float t) {
  float i = 1.0 - t;
  return 3.0*i*i*(uControlA-uStart) + 6.0*i*t*(uControlB-uControlA) + 3.0*t*t*(uEnd-uControlB);
}
vec2 force(vec2 position, vec2 source, float amount) {
  vec2 offset = position-source;
  float reach = 1.0 - smoothstep(0.0, 0.72, length(offset));
  return normalize(offset + vec2(0.0001)) * reach * amount;
}
vec2 pull(vec2 position, vec2 source, vec2 offset) {
  float reach = 1.0 - smoothstep(0.0, 0.72, length(position - source));
  return offset * reach * 0.82;
}
float pulse(vec2 position, vec3 pulseData) {
  float age = uTime - pulseData.z;
  return exp(-pow((length(position - pulseData.xy) - age * 0.82) * 17.0, 2.0))
    * step(0.0, age) * step(age, 2.8);
}
void main() {
  float t = fract(aT + uTime * aSpeed);
  vec2 p = curve(t);
  vec2 direction = normalize(tangent(t));
  vec2 normal = vec2(-direction.y, direction.x);
  float envelope = 0.055 + 0.22 * pow(sin(3.14159265 * t), 1.4);
  p += normal * (aLane * envelope + sin(t * 10.4 + aPhase) * 0.012);
  p += normal * sin(t * 8.0 + aPhase + uTime * 0.25) * 0.011;
  p += force(p, uPointer, 0.05);
  p += pull(p, uDrag, uDragOffset);
  float pulseRing = pulse(p, uPulseA) + pulse(p, uPulseB) + pulse(p, uPulseC)
    + pulse(p, uPulseD);
  vAlpha = 0.38 + fract(sin(aPhase * 91.73) * 43758.5453) * 0.62 + pulseRing;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.05 + fract(aPhase * 0.73) * 0.12, 1.0);
  gl_PointSize = 1.3 + vAlpha * 2.7;
}
`

const PARTICLE_FRAGMENT_SHADER = `
varying float vAlpha;
void main() {
  float distance = length(gl_PointCoord - vec2(0.5));
  float alpha = smoothstep(0.5, 0.0, distance) * vAlpha;
  gl_FragColor = vec4(vec3(0.72, 0.88, 1.0), alpha);
}
`

function seeded(index: number): number {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453123
  return value - Math.floor(value)
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

function toWorld(
  event: PointerEvent,
  canvas: HTMLCanvasElement,
  aspect: number,
): readonly [number, number] {
  const rect = canvas.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  const y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
  return [x * aspect, y]
}

function setCurveUniforms(uniforms: FlowUniforms, curve: FlowCurve, aspect: number) {
  const point = (value: { x: number; y: number }) => [(value.x * 2 - 1) * aspect, 1 - value.y * 2]
  uniforms.uStart.value = point(curve.start)
  uniforms.uControlA.value = point(curve.controlA)
  uniforms.uControlB.value = point(curve.controlB)
  uniforms.uEnd.value = point(curve.end)
}

/** A deterministic GPU-drawn field with no React state on its animation path. */
export class FlowFieldEngine {
  private animationFrame = 0
  private camera: OrthographicCamera
  private canvas: HTMLCanvasElement
  private connectionGeometry: BufferGeometry
  private connectionMaterial: ShaderMaterial
  private contextLost = false
  private disposed = false
  private firstFrame = true
  private frameDurationTotal = 0
  private frameSampleCount = 0
  private height = 1
  private isPaused = false
  private isDocumentHidden = false
  private lastFrameAt = performance.now()
  private lineMaterial: ShaderMaterial
  private particleMaterial: ShaderMaterial
  private particleGeometry: BufferGeometry
  private pulseCursor = 0
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
      antialias: false,
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
      uControlA: { value: [0, 0] },
      uControlB: { value: [0, 0] },
      uEnd: { value: [0, 0] },
      uPointer: { value: [10, 10] },
      uDrag: { value: [10, 10] },
      uDragOffset: { value: [0, 0] },
      uPulseA: { value: [10, 10, -10] },
      uPulseB: { value: [10, 10, -10] },
      uPulseC: { value: [10, 10, -10] },
      uPulseD: { value: [10, 10, -10] },
      uTime: { value: 0 },
    }

    this.segmentGeometry = this.createSegments()
    this.lineMaterial = new ShaderMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      fragmentShader: LINE_FRAGMENT_SHADER,
      transparent: true,
      uniforms: { ...this.uniforms, uOpacity: { value: 0.42 } },
      vertexShader: LINE_VERTEX_SHADER,
    })
    this.scene.add(new LineSegments(this.segmentGeometry, this.lineMaterial))

    this.connectionGeometry = this.createConnections()
    this.connectionMaterial = new ShaderMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      fragmentShader: LINE_FRAGMENT_SHADER,
      transparent: true,
      uniforms: { ...this.uniforms, uOpacity: { value: 0.16 } },
      vertexShader: LINE_VERTEX_SHADER,
    })
    this.scene.add(new LineSegments(this.connectionGeometry, this.connectionMaterial))

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

    this.canvas.addEventListener('pointerdown', this.handlePointerDown)
    this.canvas.addEventListener('pointermove', this.handlePointerMove)
    this.canvas.addEventListener('pointerup', this.handlePointerUp)
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel)
    this.canvas.addEventListener('pointerleave', this.handlePointerLeave)
    this.canvas.addEventListener('lostpointercapture', this.handlePointerCancel)
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.resize()
    this.animationFrame = requestAnimationFrame(this.render)
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
      for (let filament = 0; filament < quality.filaments; filament += 1) {
        const normalizedLane = (filament / (quality.filaments - 1)) * 2 - 1
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

  private createConnections(): BufferGeometry {
    const geometry = new BufferGeometry()
    const vertexCount = CONNECTION_RANGES.desktop.start + CONNECTION_RANGES.desktop.count
    const t = new Float32Array(vertexCount)
    const lane = new Float32Array(vertexCount)
    const phase = new Float32Array(vertexCount)
    let cursor = 0
    for (const variant of ['mobile', 'desktop'] as const) {
      const quality = FLOW_QUALITY[variant]
      for (let index = 0; index < quality.connections; index += 1) {
        const connectionT = 0.12 + seeded(index + 601) * 0.76
        const centerLane = seeded(index + 701) * 1.7 - 0.85
        const halfSpan = 0.025 + seeded(index + 801) * 0.045
        const connectionPhase = seeded(index + 901) * Math.PI * 2
        t[cursor] = connectionT
        lane[cursor] = centerLane - halfSpan
        phase[cursor] = connectionPhase
        cursor += 1
        t[cursor] = connectionT
        lane[cursor] = centerLane + halfSpan
        phase[cursor] = connectionPhase
        cursor += 1
      }
    }
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertexCount * 3), 3))
    geometry.setAttribute('aT', new BufferAttribute(t, 1))
    geometry.setAttribute('aLane', new BufferAttribute(lane, 1))
    geometry.setAttribute('aPhase', new BufferAttribute(phase, 1))
    geometry.setDrawRange(0, vertexCount)
    return geometry
  }

  private createParticles(): BufferGeometry {
    const geometry = new BufferGeometry()
    const count = PARTICLE_RANGES.desktop.start + PARTICLE_RANGES.desktop.count
    const t = new Float32Array(count)
    const lane = new Float32Array(count)
    const phase = new Float32Array(count)
    const speed = new Float32Array(count)
    for (let index = 0; index < count; index += 1) {
      t[index] = seeded(index + 101)
      lane[index] = seeded(index + 211) * 2 - 1
      phase[index] = seeded(index + 307) * Math.PI * 2
      speed[index] = 0.008 + seeded(index + 401) * 0.02
    }
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3))
    geometry.setAttribute('aT', new BufferAttribute(t, 1))
    geometry.setAttribute('aLane', new BufferAttribute(lane, 1))
    geometry.setAttribute('aPhase', new BufferAttribute(phase, 1))
    geometry.setAttribute('aSpeed', new BufferAttribute(speed, 1))
    geometry.setDrawRange(0, count)
    return geometry
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (this.interaction.activePointerId !== null || event.button !== 0) return
    const [x, y] = toWorld(event, this.canvas, this.width / this.height)
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
    this.canvas.setPointerCapture(event.pointerId)
  }

  private handlePointerMove = (event: PointerEvent) => {
    const [x, y] = toWorld(event, this.canvas, this.width / this.height)
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
    }
    if (this.interaction.isDragging) {
      this.interaction.targetX = x
      this.interaction.targetY = y
    }
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.interaction.activePointerId) return
    const [x, y] = toWorld(event, this.canvas, this.width / this.height)
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

  setPaused(paused: boolean) {
    this.isPaused = paused
    this.updateAnimationLoop()
  }

  private updateAnimationLoop() {
    if (this.isPaused || this.isDocumentHidden) {
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
    this.resizeWithThree()
  }

  private resizeWithThree() {
    if (this.disposed) return
    const rect = this.canvas.getBoundingClientRect()
    this.width = Math.max(1, rect.width)
    this.height = Math.max(1, rect.height)
    const aspect = this.width / this.height
    this.variant = this.width < 768 ? 'mobile' : 'desktop'
    const quality = FLOW_QUALITY[this.variant]
    const pixelRatioScale = this.reducedQuality ? 0.75 : 1
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio * pixelRatioScale),
    )
    this.renderer.setSize(this.width, this.height, false)
    setCurveUniforms(this.uniforms, FLOW_CURVES[this.variant], aspect)
    this.applyDrawRanges()
    this.camera.left = -aspect
    this.camera.right = aspect
    this.camera.top = 1
    this.camera.bottom = -1
    this.camera.updateProjectionMatrix()
  }

  private applyDrawRanges() {
    const quality = FLOW_QUALITY[this.variant]
    const segmentRange = SEGMENT_RANGES[this.variant]
    const particleRange = PARTICLE_RANGES[this.variant]
    const connectionRange = CONNECTION_RANGES[this.variant]
    const scale = this.reducedQuality ? QUALITY_REDUCTION : 1
    const filamentCount = Math.max(1, Math.floor(quality.filaments * scale))

    this.segmentGeometry.setDrawRange(segmentRange.start, filamentCount * quality.segments * 2)
    this.particleGeometry.setDrawRange(
      particleRange.start,
      Math.max(1, Math.floor(particleRange.count * scale)),
    )
    this.connectionGeometry.setDrawRange(
      connectionRange.start,
      Math.max(2, Math.floor((connectionRange.count * scale) / 2) * 2),
    )
  }

  private samplePerformance(now: number, frameDuration: number) {
    if (this.reducedQuality || frameDuration <= 0 || frameDuration > 100) return
    this.frameDurationTotal += frameDuration
    this.frameSampleCount += 1
    if (now - this.qualitySampleStartedAt < 3000 || this.frameSampleCount < 60) return

    if (this.frameDurationTotal / this.frameSampleCount > 25) {
      this.reducedQuality = true
      this.resizeWithThree()
    }
  }

  private updateInteraction(delta: number) {
    const interaction = this.interaction
    const previousX = interaction.x
    const previousY = interaction.y
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
    const offsetLength = Math.hypot(offsetX, offsetY)
    const offsetScale = offsetLength > 0.65 ? 0.65 / offsetLength : 1
    this.uniforms.uDragOffset.value = [offsetX * offsetScale, offsetY * offsetScale]
    // Preserve a finite velocity if the scene is grabbed again between frames.
    if (delta > 0) {
      interaction.velocityX =
        interaction.velocityX * 0.94 + ((interaction.x - previousX) / delta) * 0.06
      interaction.velocityY =
        interaction.velocityY * 0.94 + ((interaction.y - previousY) / delta) * 0.06
    }
  }

  private render = (now: number) => {
    if (this.disposed || this.isPaused || this.isDocumentHidden || this.contextLost) return
    const frameDuration = now - this.lastFrameAt
    const delta = Math.min(frameDuration / 1000, 0.05)
    this.lastFrameAt = now
    this.samplePerformance(now, frameDuration)
    this.updateInteraction(delta)
    this.uniforms.uTime.value = now / 1000
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
    this.connectionGeometry.dispose()
    this.particleGeometry.dispose()
    this.lineMaterial.dispose()
    this.connectionMaterial.dispose()
    this.particleMaterial.dispose()
    this.renderer.dispose()
    this.canvas.remove()
  }
}
