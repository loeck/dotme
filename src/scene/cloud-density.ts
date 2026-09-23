import { Vector4 } from 'three'

export const CLOUD_COUNT = 12
export const CLOUD_PERIOD = 640
const CLOUD_BASE = 80
const CLOUD_TOP = 140

/** Separate seeded bodies: large banks and smaller clouds can overtake one another.
 * Periodic copies keep the distant layer populated without respawning or popping. */
export function createCloudBodies(seed: number) {
  let state = (seed ^ 0xc10d5eed) >>> 0
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
  const origins: Vector4[] = []
  const radii: Vector4[] = []
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const large = i % 3 === 0
    const radius = large ? 100 + random() * 45 : 28 + random() * 32
    const height = large ? 24 + random() * 5 : 12 + random() * 8
    origins.push(
      new Vector4(
        (((i % 4) + 0.15 + random() * 0.7) * CLOUD_PERIOD) / 4 - CLOUD_PERIOD / 2 - 280,
        CLOUD_BASE + height + random() * (CLOUD_TOP - CLOUD_BASE - height * 2),
        ((Math.floor(i / 4) + 0.15 + random() * 0.7) * CLOUD_PERIOD) / 3 - CLOUD_PERIOD / 2 - 40,
        (large ? 0.55 : 1.15) + random() * 0.45,
      ),
    )
    radii.push(new Vector4(radius, height, radius * (0.6 + random() * 0.45), random() * 10))
  }
  return {
    uCloudOrigins: { value: origins },
    uCloudRadii: { value: radii },
  }
}

/** Shared world-space volume: visible clouds and their projected shadows agree. */
export const CLOUD_DENSITY_GLSL = `
precision highp sampler3D;
uniform sampler3D uNoise;
uniform vec2 uDisplacement;
uniform float uTime;
uniform vec4 uCloudOrigins[${CLOUD_COUNT}];
uniform vec4 uCloudRadii[${CLOUD_COUNT}];
const float CLOUD_BASE = ${CLOUD_BASE.toFixed(1)};
const float CLOUD_TOP = ${CLOUD_TOP.toFixed(1)};
const float CLOUD_EXTINCTION = 0.055;

float density(vec3 world, bool detail) {
  if (world.y <= CLOUD_BASE || world.y >= CLOUD_TOP) return 0.0;
  float envelope = smoothstep(CLOUD_BASE, CLOUD_BASE + 4.0, world.y)
    * (1.0 - smoothstep(CLOUD_TOP - 4.0, CLOUD_TOP, world.y));
  float total = 0.0;
  for (int i = 0; i < ${CLOUD_COUNT}; i++) {
    vec4 origin = uCloudOrigins[i];
    vec4 radii = uCloudRadii[i];
    vec3 p = world - origin.xyz;
    // Each cloud keeps its own speed factor, applied to the wind's exact integral.
    p.xz -= uDisplacement * origin.w;
    p.xz = mod(p.xz + ${CLOUD_PERIOD / 2}.0, ${CLOUD_PERIOD}.0) - ${CLOUD_PERIOD / 2}.0;
    vec3 q = p / radii.xyz;
    float boundary = dot(q, q);
    if (boundary >= 2.7) continue;
    // Local noise travels with this body, so overtaking clouds retain their shape.
    vec3 noisePoint = p * vec3(0.008, 0.016, 0.008) + radii.w;
    noisePoint += 0.025 * sin(p.zxy * 0.015 + uTime * 0.035 + radii.w);
    vec2 noise = texture(uNoise, noisePoint).rg;
    float mass = 0.6 - boundary * 0.8 + (noise.r - 0.5) * 2.4 + (noise.g - 0.5) * 0.7;
    if (detail) mass -= (1.0 - texture(uNoise, noisePoint * 2.7).g) * 0.12;
    total += smoothstep(0.03, 0.5, mass) * envelope * 0.75;
  }
  return min(total, 1.0);
}
`
