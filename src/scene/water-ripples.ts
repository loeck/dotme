import {
  DataTexture,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  RedFormat,
  UnsignedByteType,
  Vector2,
  Vector4,
} from 'three'
import type { WebGLRenderer } from 'three'
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js'
import type { Variable } from 'three/addons/misc/GPUComputationRenderer.js'

import type { Voxel } from './voxel-world'

// Fixed world coordinates: changing the camera cannot stretch existing waves.
export const RIPPLE_DOMAIN = { x: -80, z: -112, size: 160 } as const
export const RIPPLE_STEP = 1 / 120
export const RIPPLE_SPEED = 3.8

/** Bounded catch-up prevents a hidden tab or slow frame from creating a huge physics step. */
export class RippleClock {
  private remainder = 0

  advance(delta: number): number {
    this.remainder += Math.max(0, Math.min(delta, 0.05))
    const steps = Math.floor((this.remainder + 1e-9) / RIPPLE_STEP)
    this.remainder = Math.max(0, this.remainder - steps * RIPPLE_STEP)
    return steps
  }
}

/** Rasterize solid terrain, so waves reflect at banks instead of crossing through them. */
export function createRippleMask(voxels: readonly Voxel[], resolution: number): Uint8Array {
  const data = new Uint8Array(resolution * resolution).fill(255)
  const cellSize = RIPPLE_DOMAIN.size / resolution
  for (const voxel of voxels) {
    if (voxel.y + voxel.size * 0.5 < -0.035) continue
    const halfSize = voxel.size * 0.5
    const minX = Math.max(0, Math.floor((voxel.x - halfSize - RIPPLE_DOMAIN.x) / cellSize))
    const maxX = Math.min(
      resolution - 1,
      Math.floor((voxel.x + halfSize - RIPPLE_DOMAIN.x) / cellSize),
    )
    const minZ = Math.max(0, Math.floor((voxel.z - halfSize - RIPPLE_DOMAIN.z) / cellSize))
    const maxZ = Math.min(
      resolution - 1,
      Math.floor((voxel.z + halfSize - RIPPLE_DOMAIN.z) / cellSize),
    )
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) data[z * resolution + x] = 0
    }
  }
  return data
}

/** Preserve contact continuity independently of event frequency and world-space distance. */
export class RippleStroke {
  readonly segment = new Vector4()
  readonly brush = new Vector4()
  private readonly target = new Vector2()
  private readonly previous = new Vector2()
  private readonly start = new Vector2()
  private active = false
  private pressed = false
  private tap = false

  contact(x: number, z: number, pressed: boolean, tap = false) {
    this.target.set(x, z)
    if (!this.active) this.previous.copy(this.target)
    this.active = true
    this.pressed = pressed
    this.tap ||= tap
  }

  endContact() {
    this.active = false
  }

  beginFrame() {
    this.start.copy(this.previous)
  }

  advance(progress: number) {
    this.segment.x = this.previous.x
    this.segment.y = this.previous.y
    this.previous.lerpVectors(this.start, this.target, progress)
    this.segment.z = this.previous.x
    this.segment.w = this.previous.y
    this.brush.set(
      this.pressed ? 0.85 : 0.65,
      this.tap ? 0.28 : this.pressed ? 0.2 : 0.14,
      this.active || this.tap ? 1 : 0,
      this.tap ? 1 : 0,
    )
    this.tap = false
  }
}

// Damped 2D wave equation, with height in R and vertical velocity in G.
// A nine-point Laplacian reduces the directional bias of a four-neighbor stencil.
const SIMULATION_FRAGMENT = `
uniform sampler2D uWaterMask;
uniform vec4 uDomain;
uniform vec4 uStroke;
uniform vec4 uBrush; // radius, displacement, active, tap
uniform float uCellSize;

float neighborHeight(vec2 uv, float center) {
  float wet = texture2D(uWaterMask, uv).r;
  return mix(center, texture2D(heightfield, uv).r, wet);
}

// Smooth approximation of erf for the analytic integral along a stroke.
float erfApprox(float x) {
  float x2 = x * x;
  return sign(x) * sqrt(max(0.0, 1.0 - exp(-x2 * (1.273239545 + 0.147 * x2)
    / (1.0 + 0.147 * x2))));
}

float sweptPressure(vec2 world) {
  vec2 segment = uStroke.zw - uStroke.xy;
  float segmentLength = length(segment);
  if (segmentLength < 0.00001) return 0.0;
  vec2 direction = segment / segmentLength;
  vec2 delta = world - uStroke.xy;
  float along = dot(delta, direction);
  float across = dot(delta, vec2(-direction.y, direction.x));
  float radius = uBrush.x;
  if (abs(across) > radius * 3.0 || along < -radius * 3.0
    || along > segmentLength + radius * 3.0) return 0.0;

  // Integrate a volume-balanced pressure profile over the WHOLE segment.
  // A long projected movement has the same cross-section as a short one;
  // neither pointer-event spacing nor the view direction can create gaps.
  float a = 2.0 / (radius * radius);
  float rootA = sqrt(a);
  float from = along - segmentLength;
  float to = along;
  float gaussianIntegral = 0.886226925 / rootA
    * (erfApprox(rootA * to) - erfApprox(rootA * from));
  float endCorrection = 0.5 * (to * exp(-a * to * to) - from * exp(-a * from * from));
  float q = a * across * across;
  return exp(-q) * ((q - 0.5) * gaussianIntegral - endCorrection) / radius;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution.xy;
  if (texture2D(uWaterMask, uv).r < 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 texel = 1.0 / resolution.xy;
  vec2 state = texture2D(heightfield, uv).rg;
  float h = state.x;
  float cardinal = neighborHeight(uv + vec2(texel.x, 0.0), h)
    + neighborHeight(uv - vec2(texel.x, 0.0), h)
    + neighborHeight(uv + vec2(0.0, texel.y), h)
    + neighborHeight(uv - vec2(0.0, texel.y), h);
  float diagonal = neighborHeight(uv + texel, h)
    + neighborHeight(uv - texel, h)
    + neighborHeight(uv + vec2(texel.x, -texel.y), h)
    + neighborHeight(uv + vec2(-texel.x, texel.y), h);
  float laplacian = (4.0 * cardinal + diagonal - 20.0 * h) / (6.0 * uCellSize * uCellSize);
  float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  float absorption = 1.0 - smoothstep(0.0, 0.045, edge);
  float damping = exp(-(0.85 + absorption * absorption * 18.0) * STEP);
  float velocity = (state.y + SPEED * SPEED * laplacian * STEP) * damping;
  h += velocity * STEP;

  if (uBrush.z > 0.0) {
    vec2 world = uDomain.xy + uv * uDomain.zw;
    float displacement;
    if (uBrush.w > 0.5) {
      // A contact displaces water into the surrounding shoulder, with zero
      // integral on an unbounded surface (no permanent rise in water level).
      float q = dot(world - uStroke.zw, world - uStroke.zw) * 2.0 / (uBrush.x * uBrush.x);
      displacement = (q - 1.0) * exp(-q);
    } else {
      displacement = sweptPressure(world);
    }
    h += displacement * uBrush.y;
  }
  gl_FragColor = vec4(h * damping, velocity, 0.0, 1.0);
}
`

export class WaterRipples {
  readonly bounds = new Vector4(
    RIPPLE_DOMAIN.x,
    RIPPLE_DOMAIN.z,
    RIPPLE_DOMAIN.size,
    RIPPLE_DOMAIN.size,
  )
  readonly texel: Vector2
  private readonly gpu: GPUComputationRenderer
  private readonly field: Variable
  private readonly mask: DataTexture
  private readonly maskData: Uint8Array
  private readonly clock = new RippleClock()
  private readonly input = new RippleStroke()

  constructor(
    renderer: WebGLRenderer,
    private readonly resolution: number,
    terrain: readonly Voxel[],
  ) {
    this.texel = new Vector2(1 / resolution, RIPPLE_DOMAIN.size / resolution)
    this.maskData = createRippleMask(terrain, resolution)
    this.mask = new DataTexture(this.maskData, resolution, resolution, RedFormat, UnsignedByteType)
    this.mask.minFilter = NearestFilter
    this.mask.magFilter = NearestFilter
    this.mask.needsUpdate = true
    this.gpu = new GPUComputationRenderer(resolution, resolution, renderer)
    this.gpu.setDataType(HalfFloatType)
    this.field = this.gpu.addVariable('heightfield', SIMULATION_FRAGMENT, this.gpu.createTexture())
    this.field.minFilter = LinearFilter
    this.field.magFilter = LinearFilter
    this.gpu.setVariableDependencies(this.field, [this.field])
    Object.assign(this.field.material.defines, {
      STEP: RIPPLE_STEP.toFixed(10),
      SPEED: RIPPLE_SPEED.toFixed(2),
    })
    Object.assign(this.field.material.uniforms, {
      uWaterMask: { value: this.mask },
      uDomain: { value: this.bounds },
      uCellSize: { value: this.texel.y },
      uStroke: { value: this.input.segment },
      uBrush: { value: this.input.brush },
    })
    const error = this.gpu.init()
    if (error) {
      this.dispose()
      throw new Error(error)
    }
  }

  get texture() {
    return this.gpu.getCurrentRenderTarget(this.field).texture
  }

  contact(x: number, z: number, pressed: boolean, tap = false) {
    const u = (x - RIPPLE_DOMAIN.x) / RIPPLE_DOMAIN.size
    const v = (z - RIPPLE_DOMAIN.z) / RIPPLE_DOMAIN.size
    if (
      u <= 0 ||
      u >= 1 ||
      v <= 0 ||
      v >= 1 ||
      this.maskData[
        Math.floor(v * this.resolution) * this.resolution + Math.floor(u * this.resolution)
      ] === 0
    ) {
      this.endContact()
      return
    }
    this.input.contact(x, z, pressed, tap)
  }

  endContact() {
    this.input.endContact()
  }

  update(delta: number) {
    const steps = this.clock.advance(delta)
    if (steps === 0) return
    this.input.beginFrame()
    for (let index = 0; index < steps; index += 1) {
      this.input.advance((index + 1) / steps)
      this.gpu.compute()
    }
  }

  dispose() {
    this.gpu.dispose()
    this.mask.dispose()
  }
}
