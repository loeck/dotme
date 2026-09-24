import {
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  OneFactor,
  PlaneGeometry,
  ShaderMaterial,
} from 'three'
import type { IUniform, Scene } from 'three'

import { WATER_LEVEL } from './lake-bed'
import { WATER_FIELD_GLSL } from './water-surface'

export const SPLASH_IMPACT_LAYER = 4
const LIFETIME = 1.35

type Impact = { x: number; z: number; born: number; energy: number; seed: number }

const SLOPE_FRAGMENT = `
varying vec2 vOffset;
varying vec3 vLanding;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
void main() {
  float age = vLanding.x, energy = vLanding.y, seed = vLanding.z;
  float r = length(vOffset);
  vec2 radial = vOffset / max(r, 0.0001);
  vec2 pixel = vec2(dot(radial, dFdx(vOffset)), dot(radial, dFdy(vOffset)));
  float pixelVariance = dot(pixel, pixel) / 12.0;
  float life = smoothstep(0.0, 0.015, age) * (1.0 - smoothstep(0.65, 1.35, age));
  float slope = 0.0, variance = 0.0;
  // Dispersive gravity/capillary packets change the lake normal, not its paint.
  for (int i = 0; i < 3; i++) {
    float k = (17.0 + float(i) * 23.0) * mix(0.9, 1.12, seed);
    float omega = sqrt(9.81 * k + 0.000074 * k * k * k);
    float speed = (9.81 + 0.000222 * k * k) / (2.0 * omega);
    float width = 0.045 + age * 0.055;
    float packet = r - 0.035 - speed * age;
    float w2 = width * width, filtered = w2 + pixelVariance;
    float frequencyScale = w2 / filtered;
    float envelope = width / sqrt(filtered) * exp(-packet * packet / (2.0 * filtered));
    float filterWeight = exp(-0.5 * k * k * pixelVariance * frequencyScale);
    float phase = k * (r - packet * pixelVariance / filtered) - omega * age;
    float amplitude = (0.09 + 0.4 * energy) * life * exp(-age * (1.8 + float(i) * 0.45));
    slope += amplitude * envelope * filterWeight
      * (frequencyScale * cos(phase) - sin(phase) * packet / (k * filtered));
    variance += amplitude * amplitude * envelope * envelope * (1.0 - filterWeight * filterWeight) * 0.5;
  }
  // The depression collapses into a small rebound, before the rings spread.
  float cavityWidth = 0.055 + energy * 0.035 + age * 0.07;
  float cavityW2 = cavityWidth * cavityWidth + pixelVariance;
  float cavity = (0.012 + energy * 0.04) * exp(-age * 12.0) * cos(age * 16.0);
  slope += cavity * r / cavityW2 * exp(-r * r / (2.0 * cavityW2));
  slope *= smoothstep(0.0, 0.008, r);
  // Short-lived clusters of bubbles, with soft holes, never a white ring.
  vec2 p = vOffset * 42.0 + vec2(seed * 17.0, age * 0.6);
  vec2 cell = floor(p), f = fract(p) - 0.5;
  float bubbles = 1.0 - smoothstep(0.12, 0.4, length(f + vec2(hash(cell), hash(cell + 13.0)) * 0.26 - 0.13));
  bubbles = mix(bubbles, 0.28, smoothstep(0.2, 0.9, length(fwidth(p))));
  float foam = bubbles * exp(-r * r / (0.007 + energy * 0.028))
    * exp(-age * 6.0) * smoothstep(0.02, 0.06, age) * (0.15 + energy * 0.65);
  gl_FragColor = vec4(radial * slope, variance, foam);
}
`

/** Landing waves are accumulated into the existing water-normal buffer. */
export class SplashImpacts {
  readonly mesh: InstancedMesh<PlaneGeometry, MeshStandardMaterial>
  readonly slopes: InstancedMesh<PlaneGeometry, ShaderMaterial>
  private readonly pool: Array<Impact | null>
  private readonly transform = new Object3D()
  private cursor = 0
  private readonly uniforms: Record<string, IUniform> = {}
  landed = 0
  active = 0

  constructor(scene: Scene, mobile: boolean) {
    this.pool = Array.from({ length: mobile ? 64 : 128 }, () => null)
    const makeData = () =>
      new InstancedBufferAttribute(new Float32Array(this.pool.length * 3), 3).setUsage(
        DynamicDrawUsage,
      )
    const geometry = new PlaneGeometry(1, 1, 64, 7)
    geometry.setAttribute('aLanding', makeData())
    const material = new MeshStandardMaterial({
      color: 0x91b9bd,
      roughness: 0.1,
      envMapIntensity: 1.2,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      forceSinglePass: true,
    })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = `${WATER_FIELD_GLSL}
attribute vec3 aLanding;
varying vec3 vLanding;
varying vec2 vLandingUv;
${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        `
vLanding = aLanding;
vLandingUv = uv;
float angle = uv.x * 6.283185;
float age = aLanding.x, energy = aLanding.y;
float duration = mix(0.22, 0.34, aLanding.z);
float lift = sin(clamp(age / duration, 0.0, 1.0) * 3.141593);
float radius = (0.055 + age * 0.32 + uv.y * 0.045)
  * mix(0.85, 1.18, fract(aLanding.z * 17.3))
  * (1.0 + sin(angle * 3.0 + aLanding.z * 13.0) * 0.12);
float lobes = 5.0 + floor(fract(aLanding.z * 7.13) * 5.0);
float teeth = 0.82 + 0.12 * sin(angle * lobes + aLanding.z * 47.0)
  + 0.06 * sin(angle * (lobes + 4.0) + aLanding.z * 29.0);
vec3 transformed = vec3(cos(angle) * radius,
  sin(uv.y * 3.141593) * lift * (0.025 + energy * 0.075) * teeth,
  sin(angle) * radius);
vec3 landingWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
transformed.y += heightAt(landingWorld.xz, 0.0) + 0.004;
`,
      )
      shader.fragmentShader = `varying vec3 vLanding;
varying vec2 vLandingUv;
${shader.fragmentShader}`
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
float duration = mix(0.22, 0.34, vLanding.z);
float fade = smoothstep(0.0, 0.025, vLanding.x) * (1.0 - smoothstep(duration * 0.43, duration, vLanding.x));
float edge = sin(vLandingUv.y * 3.141593);
diffuseColor.a *= fade * edge * (0.18 + vLanding.y * 0.28);
if (diffuseColor.a < 0.004) discard;
`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
normal = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition))) * (gl_FrontFacing ? 1.0 : -1.0);
diffuseColor.a *= 0.2 + 0.8 * pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 2.0);
`,
        )
    }
    material.customProgramCacheKey = () => 'splash-landing-crown-v3'
    this.mesh = new InstancedMesh(geometry, material, this.pool.length)
    this.mesh.name = 'splash-water-crowns'
    this.mesh.layers.set(SPLASH_IMPACT_LAYER)
    this.mesh.receiveShadow = true
    this.mesh.renderOrder = 3
    scene.add(this.mesh)

    const slopeGeometry = new PlaneGeometry(2, 2, 8, 8).rotateX(-Math.PI / 2)
    slopeGeometry.setAttribute('aLanding', makeData())
    const slopeMaterial = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `${WATER_FIELD_GLSL}
attribute vec3 aLanding;
varying vec3 vLanding;
varying vec2 vOffset;
void main() {
  vLanding = aLanding;
  float radius = 0.9;
  vOffset = position.xz * radius;
  vec3 world = (modelMatrix * instanceMatrix * vec4(position.x * radius, 0.0, position.z * radius, 1.0)).xyz;
  world.y += heightAt(world.xz, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`,
      fragmentShader: SLOPE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      toneMapped: false,
      side: DoubleSide,
      forceSinglePass: true,
    })
    this.slopes = new InstancedMesh(slopeGeometry, slopeMaterial, this.pool.length)
    this.slopes.name = 'splash-water-normal-packets'
    for (const mesh of [this.mesh, this.slopes]) {
      mesh.instanceMatrix.setUsage(DynamicDrawUsage)
      mesh.frustumCulled = false
      mesh.visible = false
      mesh.count = 0
    }
  }

  setWaterSurface(uniforms: Record<string, IUniform>) {
    for (const name of [
      'uTime',
      'uState',
      'uMask',
      'uCell',
      'uWindRotation',
      'uWindRotationVelocity',
      'uWindResponse',
    ])
      this.uniforms[name] = uniforms[name]!
  }

  add(x: number, z: number, time: number, energy: number) {
    this.landed++
    // A spray cluster collapses into one stronger disturbance instead of a
    // stack of identical circles. Individual simulation impulses still land.
    for (const impact of this.pool) {
      if (
        impact &&
        time >= impact.born &&
        time - impact.born < 0.1 &&
        Math.hypot(x - impact.x, z - impact.z) < 0.22
      ) {
        impact.energy = Math.min(1.5, Math.hypot(impact.energy, energy))
        return
      }
    }
    const seed = Math.sin(x * 12.9898 + z * 78.233 + time * 3.1) * 43758.5453
    this.pool[this.cursor] = { x, z, born: time, energy, seed: seed - Math.floor(seed) }
    this.cursor = (this.cursor + 1) % this.pool.length
  }

  update(time: number, reducedMotion = false) {
    const crownData = this.mesh.geometry.getAttribute('aLanding') as InstancedBufferAttribute
    const slopeData = this.slopes.geometry.getAttribute('aLanding') as InstancedBufferAttribute
    this.active = 0
    let crowns = 0
    for (let i = 0; i < this.pool.length; i++) {
      const impact = this.pool[i]
      const age = impact ? time - impact.born : LIFETIME
      if (!impact || age < 0 || age >= LIFETIME || reducedMotion) {
        this.pool[i] = null
        continue
      }
      this.transform.position.set(impact.x, WATER_LEVEL, impact.z)
      this.transform.updateMatrix()
      slopeData.setXYZ(this.active, age, impact.energy, impact.seed)
      this.slopes.setMatrixAt(this.active++, this.transform.matrix)
      if (age < 0.22 + impact.seed * 0.12 && impact.energy > 0.2) {
        crownData.setXYZ(crowns, age, impact.energy, impact.seed)
        this.mesh.setMatrixAt(crowns++, this.transform.matrix)
      }
    }
    crownData.needsUpdate = slopeData.needsUpdate = true
    this.mesh.instanceMatrix.needsUpdate = this.slopes.instanceMatrix.needsUpdate = true
    this.mesh.count = crowns
    this.slopes.count = this.active
    this.mesh.visible = crowns > 0
    this.slopes.visible = this.active > 0
  }

  dispose() {
    for (const mesh of [this.mesh, this.slopes]) {
      mesh.removeFromParent()
      mesh.geometry.dispose()
      mesh.material.dispose()
      mesh.dispose()
    }
  }
}
