import { IMPACT_LIFETIME } from './rain-simulation'
import { WATER_FIELD_GLSL } from './water-surface'

export const RAIN_EXPOSURE = 1 / 90
export const RAIN_CROWN_LIFETIME = 0.13
export const RAIN_SPRAY_LIFETIME = 0.18

const RAIN_ILLUMINATION = `
uniform vec3 uMoonColor;
uniform vec3 uMoonDirection;
uniform vec3 uLampPosition[LAMP_COUNT];
uniform vec3 uLampColor[LAMP_COUNT];
varying vec3 vWorld;
vec3 rainLight() {
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float moonGlint = 0.35 + 0.65 * pow(abs(dot(viewDir, uMoonDirection)), 5.0);
  vec3 light = uMoonColor * moonGlint;
  for (int i = 0; i < LAMP_COUNT; i++) {
    if (all(equal(uLampColor[i], vec3(0.0)))) continue;
    vec3 delta = uLampPosition[i] - vWorld;
    float d2 = dot(delta, delta);
    float glint = 0.3 + 0.7 * pow(abs(dot(viewDir, normalize(delta))), 3.0);
    light += uLampColor[i] * glint / (1.0 + d2);
  }
  return light * exp(-length(cameraPosition - vWorld) * 0.009);
}
`

const RAIN_OCCLUSION = `
uniform sampler2D uDepth;
uniform bool uOverlay;
uniform vec2 uResolution;
uniform float uOpacity;
void occludeRain() {
  if (uOverlay && gl_FragCoord.z > texture2D(uDepth, gl_FragCoord.xy / uResolution).r + 0.000001)
    discard;
}`

// All sizes are metres. The exposure is deliberately unrelated to the frame delta.
export const RAIN_VERTEX = `
#ifdef SURFACE_SPRAY
${WATER_FIELD_GLSL}
#endif
attribute vec4 aDrop;
attribute vec4 aVelocity;
#ifndef SURFACE_SPRAY
attribute float aContactAge;
#endif
uniform vec2 uResolution;
uniform float uPixelRatio;
uniform bool uReflectionPass;
varying vec2 vUv;
${RAIN_ILLUMINATION}
varying vec3 vRainLight;
varying float vCoverage;
varying float vSeed;
varying float vProfileContrast;
varying float vSide;
varying float vPhysicalWidth;
void main() {
  vUv = uv;
  vWorld = aDrop.xyz;
  #ifdef SURFACE_SPRAY
    vWorld.y += heightAt(vWorld.xz, 0.0);
  #endif
  // Every corner shares the same world-space drop position and lighting.
  vRainLight = rainLight();
  vSeed = aVelocity.w;
  vec4 head = viewMatrix * vec4(vWorld, 1.0);
  // A short shutter gives readable falling drops instead of long white slashes.
  // Exposure stays constant across frame rates and daylight/time-scale changes.
  float exposure = ${RAIN_EXPOSURE};
  #ifndef SURFACE_SPRAY
    exposure = max(0.0, exposure - max(0.0, aContactAge));
  #endif
  vec3 motion = mat3(viewMatrix) * aVelocity.xyz * exposure;
  vec4 tailClip = projectionMatrix * vec4(head.xyz - motion, 1.0);
  vec4 headClip = projectionMatrix * head;
  vec2 screenMotion = (headClip.xy / headClip.w - tailClip.xy / tailClip.w) * uResolution * 0.5;
  float streak = length(screenMotion);
  vec2 direction = streak > 0.001 ? screenMotion / streak : vec2(0.0, -1.0);
  // aDrop.w is a diameter, and NDC spans two units over the viewport height.
  float physicalWidth = aDrop.w * projectionMatrix[1][1] * uResolution.y * 0.5 / max(0.1, -head.z);
  // Only drops almost against the lens defocus noticeably. A broad near-field
  // blur makes ordinary rain look like snow or luminous ribbons.
  float coc = 0.65 * (1.0 - smoothstep(0.8, 4.0, -head.z)) * uPixelRatio;
  #ifdef SURFACE_SPRAY
    // The splash sits on the lake's focus plane, not in the near airborne veil.
    coc *= 0.22;
  #endif
  // Reconstruction is in device pixels, not CSS pixels: high-DPI displays must
  // resolve finer drops, not magnify an imposed minimum width.
  // The Gaussian's FWHM is 0.396 of its support. A 2.5 px support therefore
  // reconstructs a one-pixel line; a 1.25 px support lost almost all energy
  // whenever a drop fell between pixel centres.
  float width = sqrt(physicalWidth * physicalWidth + 2.5 * 2.5 + coc * coc * 4.0);
  vProfileContrast = 1.0 / (1.0 + coc * 0.5);
  // The mirror is lower resolution than the screen. Its minimum-width Gaussian
  // became a broad luminous wisp after projection through the moving surface.
  // Bound a physical thin line plus a one-texel integration margin instead.
  if (uReflectionPass) width = physicalWidth + 2.0;
  vSide = position.x * width;
  vPhysicalWidth = physicalWidth;
  float lengthPx = max(streak, 1.0) + (uReflectionPass ? 1.0 : width);
  vec2 side = vec2(-direction.y, direction.x);
  vec2 offset = side * position.x * width + direction * position.y * lengthPx;
  gl_Position = headClip;
  gl_Position.xy += (offset - direction * streak * 0.5) * 2.0 / uResolution * headClip.w;
  // Preserve integrated energy when widening the aperture footprint.
  vCoverage = (uReflectionPass ? 1.0 : min(1.0, physicalWidth / width)) * max(streak, 1.0) / lengthPx
    * exposure / ${RAIN_EXPOSURE};
}
`

export const RAIN_FRAGMENT = `
${RAIN_OCCLUSION}
uniform bool uReflectionPass;
varying vec3 vRainLight;
varying vec2 vUv;
varying float vCoverage;
varying float vSeed;
varying float vProfileContrast;
varying float vSide;
varying float vPhysicalWidth;
void main() {
  occludeRain();
  float across;
  if (uReflectionPass) {
    // Pixel-integrated coverage retains subpixel drops between texel centres,
    // without inflating their optical diameter. fwidth accounts for streak angle.
    float pixelSpan = max(fwidth(vSide), 0.0001);
    float halfDrop = vPhysicalWidth * 0.5;
    across = max(0.0, min(vSide + pixelSpan * 0.5, halfDrop)
      - max(vSide - pixelSpan * 0.5, -halfDrop)) / pixelSpan;
  }
  else across = exp(-pow((vUv.x - 0.5) * 4.2, 2.0));
  float ends = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.8, 1.0, vUv.y));
  float profile = pow(sin(vUv.y * (9.0 + vSeed * 17.0) + vSeed * 50.0), 2.0);
  float lobes = mix(0.72, 0.35 + 0.65 * profile, vProfileContrast);
  // Preserve subpixel energy without making every drop a white, opaque rod.
  // Independent seeded brightness retains occasional glints among quiet drops.
  float glint = mix(0.75, 1.0, vSeed * vSeed);
  float alpha;
  #ifdef SURFACE_SPRAY
    alpha = (uReflectionPass ? min(0.85, across * vCoverage * 5.5)
      : across * min(0.85, vCoverage * 13.0)) * ends * uOpacity;
  #else
    alpha = (uReflectionPass ? min(0.65, across * vCoverage * 2.0)
      : across * min(0.65, vCoverage * 4.8)) * ends * lobes * glint * uOpacity;
  #endif
  gl_FragColor = vec4(vRainLight, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export const SLOPE_VERTEX = `
attribute vec4 aImpact;
attribute vec4 aArrival;
${WATER_FIELD_GLSL}
varying vec2 vOffset;
varying vec4 vImpact;
void main() {
  // Bound the expanding packet, including its reconstruction footprint.
  vOffset = position.xy * (0.38 + aImpact.z * 0.75);
  vImpact = vec4(aImpact.zw, aArrival.zw);
  vec3 world = vec3(aImpact.x + vOffset.x, -0.035, aImpact.y + vOffset.y);
  // Share the lake's wind spectrum and pointer displacement.
  world.y += heightAt(world.xz, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`

export const SLOPE_FRAGMENT = `
varying vec2 vOffset;
varying vec4 vImpact;
void main() {
  float r = length(vOffset);
  float age = vImpact.x;
  vec2 radial = vOffset / max(r, 0.0001);
  vec2 radialPixel = vec2(dot(radial, dFdx(vOffset)), dot(radial, dFdy(vOffset)));
  // A box pixel has variance 1/12. Filter in the radial direction: the long
  // axis of a grazing pixel must not erase a wave travelling across its short axis.
  float pixelVariance = dot(radialPixel, radialPixel) / 12.0;
  float size = clamp((vImpact.y - 0.0006) / 0.0038, 0.0, 1.0);
  float energy = clamp(vImpact.w, 0.0, 1.0);
  float strength = 0.18 * sqrt(energy);
  float duration = mix(0.45, ${IMPACT_LIFETIME}, sqrt(energy));
  float life = smoothstep(0.0, 0.012, age) * (1.0 - smoothstep(duration * 0.45, duration, age));
  float slope = 0.0;
  float variance = 0.0;
  // Three capillary/gravity wave packets: omega² = g*k + (sigma/rho)*k³.
  // Analytic radial height derivatives add linearly before normal reconstruction.
  for (int i = 0; i < 3; i++) {
    float k = (90.0 + float(i) * 95.0) * (0.9 + vImpact.z * 0.2);
    float omega = sqrt(9.81 * k + 0.000074 * k * k * k);
    float groupSpeed = (9.81 + 3.0 * 0.000074 * k * k) / (2.0 * omega);
    float width = 0.025 + age * 0.035;
    float packet = r - 0.012 - groupSpeed * age;
    float w2 = width * width;
    float filteredWidth2 = w2 + pixelVariance;
    float frequencyScale = w2 / filteredWidth2;
    // Convolve the Gaussian wave packet, including its carrier and envelope.
    float envelope = width / sqrt(filteredWidth2) * exp(-packet * packet / (2.0 * filteredWidth2));
    float filterWeight = exp(-0.5 * k * k * pixelVariance * frequencyScale);
    float phase = k * (r - packet * pixelVariance / filteredWidth2) - omega * age;
    float amplitude = strength * life * exp(-age * (2.5 + float(i) * 0.7));
    slope += amplitude * envelope * filterWeight
      * (frequencyScale * cos(phase) - sin(phase) * packet / (k * filteredWidth2));
    // Unresolved waves still scatter reflected light. Keep their mean-square
    // slope as roughness instead of making the distant lake perfectly smooth.
    float energyWidth2 = w2 + 2.0 * pixelVariance;
    float energyEnvelope = width / sqrt(energyWidth2) * exp(-packet * packet / energyWidth2);
    variance += 0.5 * amplitude * amplitude * energyEnvelope * (1.0 - filterWeight * filterWeight);
  }
  // Brief depression at contact, then its collapse. Millimetre depth, not foam.
  float cavityWidth = 0.018 + size * 0.024 + age * 0.1;
  float cavityWidth2 = cavityWidth * cavityWidth + pixelVariance;
  float cavityDepth = (0.0005 + energy * 0.005) * life * exp(-age * 22.0);
  slope += cavityDepth * r / cavityWidth2 * exp(-r * r / (2.0 * cavityWidth2))
    * cavityWidth * cavityWidth / cavityWidth2;
  slope *= smoothstep(0.0, 0.008, r);
  gl_FragColor = vec4(radial * slope, variance, 0.0);
}
`

export const CROWN_VERTEX = `
attribute vec4 aImpact;
attribute vec4 aArrival;
${WATER_FIELD_GLSL}
varying vec3 vWorld;
varying vec2 vUv;
varying float vFade;
void main() {
  float age = aImpact.z;
  float life = age / ${RAIN_CROWN_LIFETIME};
  float angle = uv.x * 6.2831853;
  float scale = aImpact.w / 0.003;
  vec2 radial = vec2(cos(angle), sin(angle));
  float teeth = 0.72 + 0.28 * sin(angle * 7.0 + aArrival.z * 31.0);
  float radius = (0.006 + age * 0.1 + uv.y * 0.004) * scale;
  float height = sin(clamp(life, 0.0, 1.0) * 3.1415926) * 0.018 * teeth * uv.y * scale;
  vec2 drift = aArrival.xy * age * 0.035 * uv.y;
  vWorld = vec3(aImpact.x + radial.x * radius + drift.x, -0.032 + height,
    aImpact.y + radial.y * radius + drift.y);
  vWorld.y += heightAt(vWorld.xz, 0.0);
  vUv = uv;
  vFade = 1.0 - smoothstep(0.045, ${RAIN_CROWN_LIFETIME}, age);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`

export const CROWN_FRAGMENT = `
${RAIN_ILLUMINATION}
${RAIN_OCCLUSION}
varying vec2 vUv;
varying float vFade;
void main() {
  occludeRain();
  float rim = smoothstep(0.55, 1.0, vUv.y);
  vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float grazing = 1.0 - abs(dot(normal, normalize(cameraPosition - vWorld)));
  float fresnel = 0.02037 + 0.97963 * pow(grazing, 5.0);
  gl_FragColor = vec4(rainLight(), (0.04 + rim * 0.24) * (0.3 + 0.7 * sqrt(fresnel)) * vFade * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
