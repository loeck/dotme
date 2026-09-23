/** Screen-space lamp optics, kept separate from the continuous water surface. */
export const LAMP_REFLECTIONS_GLSL = `
vec3 lampReflections(vec2 screenPx, vec2 slope, vec3 normal, vec3 skyNormal) {
  vec3 light = vec3(0.0);
  for (int i = 0; i < 7; i++) {
    vec4 lamp = uLampScreens[i];
    if (lamp.z <= 0.0) continue;
    vec2 contact = lamp.xy * uResolution;
    float along = screenPx.y - contact.y;
    float prominence = clamp((lamp.z - 0.40) / 0.75, 0.0, 1.0);
    float length = mix(75.0, 145.0, prominence)
      * clamp(uResolution.y / 941.0, 0.7, 1.35);
    if (along < 0.0 || along > length * 1.14
      || abs(screenPx.x - contact.x) > 75.0) continue;
    float progress = along / length;
    // Smoothly lose energy and width at the tail: no isolated terminal light.
    float reach = smoothstep(0.0, 3.5, along)
      * (1.0 - smoothstep(0.77, 1.10, progress));
    float wave = smoothNoise(along * 0.083 + float(i) * 9.71 - uTime * 0.18);
    float ripple = smoothNoise(along * 0.32 + float(i) * 17.31 + uTime * 0.33);
    float lowerColumn = smoothstep(0.18, 0.70, progress);
    float drift = slope.x * 20.0
      + sin(along * 0.057 + uTime * 0.48 + float(i) * 2.41) * 1.15
      + (wave - 0.5) * 2.7;
    float lateral = screenPx.x - contact.x + drift;
    float spread = mix(0.62, 1.55, ripple) * mix(0.85, 1.12, wave);
    float coreWidth = mix(2.1, 4.4, prominence)
      * mix(spread, 1.0 + (wave - 0.5) * 0.65 + (ripple - 0.5) * 0.25, lowerColumn)
      * (1.0 - smoothstep(0.78, 1.14, progress) * 0.10);
    float core = exp(-pow(lateral / coreWidth, 2.0));
    // The top resolves into scattered water facets. Below, they overlap into
    // a continuous luminous column, retaining a little liquid variation.
    float facets = mix(0.20 + smoothstep(0.25, 0.72, ripple) * 0.80,
      0.66 + wave * 0.23 + ripple * 0.11, lowerColumn);
    float haloWidth = mix(17.0, 32.0, prominence) + along * 0.055;
    float halo = exp(-pow(lateral / haloWidth, 2.0))
      * smoothstep(0.0, 10.0, along)
      * (1.0 - smoothstep(0.46, 1.14, progress));
    float innerGlow = exp(-pow(lateral / (coreWidth * 2.7), 2.0));
    // Bright fragments spread across the ripple crests around the column,
    // breaking its silhouette without introducing a regular dashed ladder.
    float facetNoise = noise2D(vec2(lateral * 0.20 + float(i) * 4.7,
      along * 0.41 - uTime * 0.32));
    float glintWidth = coreWidth * (1.3 + ripple * 2.6);
    float glints = exp(-pow(lateral / glintWidth, 2.0))
      * smoothstep(0.53, 0.81, facetNoise) * (1.0 - lowerColumn * 0.52);
    vec3 reflectionColor = mix(vec3(0.45, 0.62, 0.77), vec3(0.80, 0.65, 0.49), lamp.w);
    vec3 hotCore = mix(vec3(0.76, 0.88, 1.0), vec3(1.0, 0.91, 0.77), lamp.w);
    light += reflectionColor * halo * lamp.z * mix(0.19, 0.29, prominence);
    light += reflectionColor * innerGlow * reach * lamp.z * 0.22;
    light += reflectionColor * glints * reach * lamp.z * 0.43;
    light += hotCore * core * reach * facets * lamp.z
      * (0.87 + 0.13 * clamp(dot(normal, skyNormal), 0.0, 1.0));
  }
  return light;
}
`
