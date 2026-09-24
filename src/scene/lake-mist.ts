import {
  Color,
  DataTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RedFormat,
  ShaderMaterial,
  Vector2,
} from 'three'
import type { Scene } from 'three'

import { LAKE_BOUNDS, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'
import type { WindState } from './wind'

export type LakeMistOptions = Readonly<{
  reducedMotion?: boolean
  intensity?: number
  daylight?: number
  lightColor?: Color
}>

const VERTEX = `
attribute vec3 aCenter;
attribute vec3 aShape;
uniform float uTime;
uniform vec2 uDrift;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec3 center = aCenter;
  center.xz += sin(uDrift * 0.022 + aShape.z) * 0.85;
  // Cylindrical billboards stay low and upright in every rendering camera,
  // including the lake reflection and the six environment capture cameras.
  vec3 right = vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]);
  right /= max(length(right), 0.0001);
  vWorld = center + right * position.x * aShape.x;
  vWorld.y += position.y * aShape.y;
  // Only the upper fringe breathes; the foot stays below the water surface.
  vWorld.y += sin(uTime * 0.11 + aShape.z) * 0.012 * uv.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`

const FRAGMENT = `
uniform sampler2D uWater;
uniform vec2 uDrift;
uniform vec3 uColor;
uniform float uIntensity;
varying vec2 vUv;
varying vec3 vWorld;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(cell), hash(cell + vec2(1.0, 0.0)), f.x),
    mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0)), f.x), f.y);
}
void main() {
  vec2 waterUv = (vWorld.xz - vec2(${LAKE_BOUNDS.minX.toFixed(1)}, ${LAKE_BOUNDS.minZ.toFixed(1)})) / ${LAKE_BOUNDS.size.toFixed(1)};
  if (any(lessThan(waterUv, vec2(0.0))) || any(greaterThan(waterUv, vec2(1.0)))) discard;
  float water = smoothstep(0.48, 0.98, texture2D(uWater, waterUv).r);
  vec2 p = vWorld.xz * 0.38 - uDrift * 0.032;
  p += vec2(vWorld.y * 0.5, vWorld.y * 1.4);
  float density = noise(p) * 0.65 + noise(p * 2.13 + 17.0) * 0.35;
  float edge = pow(max(0.0, sin(vUv.x * 3.14159265)), 1.5);
  // Start the soft fade below the water, whose depth naturally clips the foot.
  // A varying upper fringe avoids a floating horizontal ribbon.
  float top = 0.62 + density * 0.38;
  edge *= smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.28, top, vUv.y));
  float alpha = edge * smoothstep(0.22, 0.78, density) * water * uIntensity;
  if (alpha < 0.001) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** Local, depth-tested wisps: one instanced draw, without a volume render pass. */
export class LakeMist {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>
  private readonly water: DataTexture
  private readonly nightColor = new Color(0x647b8c)
  private readonly dayColor = new Color(0xc0cfda)

  constructor(scene: Scene, bed: LakeBed, seed: number, mobile: boolean) {
    let state = (seed ^ 0x57a15817) >>> 0
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state / 0x1_0000_0000
    }
    const candidates: number[] = []
    const cell = LAKE_BOUNDS.size / bed.resolution
    for (let i = 0; i < bed.water.length; i += 3) {
      const x = LAKE_BOUNDS.minX + ((i % bed.resolution) + 0.5) * cell
      const z = LAKE_BOUNDS.minZ + (Math.floor(i / bed.resolution) + 0.5) * cell
      if (
        bed.water[i] &&
        bed.depth[i]! > 0.45 &&
        bed.depth[i]! < 3.2 &&
        bed.obstacle[i]! < WATER_LEVEL &&
        Math.abs(x) < 55 &&
        z > -72 &&
        z < 7
      )
        candidates.push(i)
    }
    const centers: number[] = [],
      shapes: number[] = []
    const budget = mobile ? 8 : 18
    // Keep wisps separate; repeating the same patch would make an opaque wall.
    for (let attempt = 0; attempt < budget * 30 && centers.length / 3 < budget; attempt++) {
      const index = candidates[Math.floor(random() * candidates.length)]
      if (index === undefined) break
      const x = LAKE_BOUNDS.minX + ((index % bed.resolution) + 0.5) * cell
      const z = LAKE_BOUNDS.minZ + (Math.floor(index / bed.resolution) + 0.5) * cell
      let crowded = false
      for (let j = 0; j < centers.length; j += 3) {
        if (Math.hypot(x - centers[j]!, z - centers[j + 2]!) < 5) crowded = true
      }
      if (crowded) continue
      const height = 0.25 + random() * 0.2
      centers.push(x, WATER_LEVEL - 0.08 + height / 2, z)
      shapes.push(7 + random() * 8, height, random() * Math.PI * 2)
    }
    this.water = new DataTexture(bed.water, bed.resolution, bed.resolution, RedFormat)
    this.water.minFilter = this.water.magFilter = LinearFilter
    this.water.needsUpdate = true
    const plane = new PlaneGeometry(1, 1)
    const geometry = new InstancedBufferGeometry()
    geometry.index = plane.index
    geometry.setAttribute('position', plane.attributes.position!)
    geometry.setAttribute('uv', plane.attributes.uv!)
    geometry.setAttribute('aCenter', new InstancedBufferAttribute(new Float32Array(centers), 3))
    geometry.setAttribute('aShape', new InstancedBufferAttribute(new Float32Array(shapes), 3))
    geometry.instanceCount = centers.length / 3
    plane.dispose()
    const material = new ShaderMaterial({
      uniforms: {
        uWater: { value: this.water },
        uTime: { value: 0 },
        uDrift: { value: new Vector2() },
        uColor: { value: this.nightColor.clone() },
        uIntensity: { value: 0.15 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      forceSinglePass: true,
    })
    this.mesh = new Mesh(geometry, material)
    this.mesh.name = 'lake-mist'
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
    scene.add(this.mesh)
  }

  update(time: number, wind: WindState, options: LakeMistOptions = {}) {
    const uniforms = this.mesh.material.uniforms
    uniforms.uTime!.value = options.reducedMotion ? 0 : time
    if (options.reducedMotion) uniforms.uDrift!.value.set(0, 0)
    else uniforms.uDrift!.value.fromArray(wind.displacement)
    const daylight = Math.max(0, Math.min(1, options.daylight ?? 0))
    const color = uniforms.uColor!.value as Color
    color.copy(this.nightColor).lerp(this.dayColor, daylight)
    if (options.lightColor) color.lerp(options.lightColor, 0.24)
    uniforms.uIntensity!.value =
      (Math.max(0, Math.min(1, options.intensity ?? 1)) * (0.17 - daylight * 0.065)) /
      (1 + (options.reducedMotion ? 0 : Math.max(0, wind.speed - 3) * 0.08))
    this.mesh.visible = this.mesh.geometry.instanceCount > 0 && uniforms.uIntensity!.value > 0.001
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.water.dispose()
  }
}
