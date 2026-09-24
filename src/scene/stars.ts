import { Vector3 } from 'three'
import type { PerspectiveCamera } from 'three'

import { leafRandom } from './leaf-drift'

export function starVisibility(sunHeight: number, brightness = 1) {
  const t = Math.max(0, Math.min(1, (-sunHeight - 0.015 - (1 - brightness) * 0.09) / 0.13))
  return t * t * (3 - 2 * t)
}

/** Counts only active, visible night seconds. Missed/covered attempts never queue. */
export class ShootingStars {
  private readonly random: () => number
  remaining: number
  age = 2
  attempts = 0
  readonly start = new Vector3()
  readonly end = new Vector3()
  constructor(seed: number) {
    this.random = leafRandom(seed ^ 0x57a25)
    this.remaining = this.interval()
  }
  private interval() {
    return 90 + this.random() * 90
  }
  advance(
    dt: number,
    sunHeight: number,
    covered: boolean,
    frozen: boolean,
    camera: PerspectiveCamera,
  ) {
    if (frozen) {
      this.age = 2
      return
    }
    const delta = Math.max(0, dt)
    this.age += delta
    if (starVisibility(sunHeight) < 0.95 || covered) {
      this.age = 2
      return
    }
    this.remaining -= delta
    if (this.remaining > 0) return
    this.remaining = this.interval()
    this.attempts++
    // Upper third of the current frustum, comfortably above distant relief.
    const x = (this.random() - 0.5) * 0.9,
      y = 0.45 + this.random() * 0.3
    const sign = this.random() > 0.5 ? 1 : -1
    this.start.set(x, y, 0.5).unproject(camera).sub(camera.position).normalize()
    this.end
      .set(x + sign * 0.24, y - 0.18, 0.5)
      .unproject(camera)
      .sub(camera.position)
      .normalize()
    this.age = 0
  }
}

export const STAR_RADIANCE_GLSL = `
uniform float uStarTime;
uniform vec3 uMeteorStart;
uniform vec3 uMeteorEnd;
uniform float uMeteorAge;
vec3 starHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + uSeed);
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yzz) * q.zyx);
}
vec3 stellarRadiance(vec3 direction, float moonAngle) {
  if (uSunDirection.y >= -0.015) return vec3(0.0);
  vec2 sky = vec2(atan(direction.x, -direction.z) * 31.8309886, asin(direction.y) * 63.6619772);
  vec2 cell = floor(sky);
  vec3 random = starHash(cell);
  vec2 offset = fract(sky) - (0.15 + random.xy * 0.7);
  float brightness = pow(random.z, 7.0);
  float visibility = smoothstep(0.0, 0.13, -uSunDirection.y - 0.015 - (1.0 - brightness) * 0.09);
  float radius = mix(0.010, 0.032, brightness);
  float variance = radius * radius;
  float pixelVariance = dot(fwidth(sky), fwidth(sky)) / 12.0;
  float filtered = variance + pixelVariance;
  float point = exp(-dot(offset, offset) / (2.0 * filtered)) * variance / filtered;
  float twinkle = 1.0 + 0.055 * sin(uStarTime * (0.42 + random.y * 0.45) + random.x * 61.0);
  float horizonFade = smoothstep(0.025, 0.2, direction.y);
  float lunarFade = mix(0.15, 1.0, smoothstep(0.02, 0.3, moonAngle));
  vec3 radiance = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.88, 0.7), random.x)
    * point * (0.008 + brightness * 0.22) * visibility * twinkle * horizonFade * lunarFade;
  if (uMeteorAge >= 0.0 && uMeteorAge < 1.15) {
    float progress = clamp(uMeteorAge / 0.85, 0.0, 1.0);
    vec3 head = normalize(mix(uMeteorStart, uMeteorEnd, progress));
    vec3 tail = normalize(mix(uMeteorStart, uMeteorEnd, max(0.0, progress - 0.19)));
    vec3 segment = head - tail;
    float along = clamp(dot(direction - tail, segment) / max(dot(segment, segment), 0.000001), 0.0, 1.0);
    float distance = length(direction - normalize(tail + segment * along));
    float width = max(length(fwidth(direction)) * 0.55, 0.00035);
    float line = exp(-distance * distance / (width * width)) * (0.00035 / width);
    float life = smoothstep(0.0, 0.08, uMeteorAge) * (1.0 - smoothstep(0.65, 1.15, uMeteorAge));
    radiance += vec3(0.68, 0.8, 1.0) * line * along * life * 0.7 * horizonFade;
  }
  return radiance;
}
`
