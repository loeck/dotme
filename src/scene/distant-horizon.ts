/** The visible distant relief also occludes direct celestial light on the lake. */
export const DISTANT_HORIZON_GLSL = `

float horizonHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float horizonNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(horizonHash(i), horizonHash(i + vec2(1.0, 0.0)), f.x),
    mix(horizonHash(i + vec2(0.0, 1.0)), horizonHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float horizonRidge(float x, float centre, float width, float height) {
  float distanceFromPeak = (x - centre) / width;
  return height * exp(-distanceFromPeak * distanceFromPeak);
}

vec3 distantPeaks(float azimuth, float seed, float mobile) {
  float farPeak;
  float middlePeak;
  float nearPeak;
  if (mobile > 0.5) {
    farPeak = 0.004 + max(
      horizonRidge(azimuth, -0.165, 0.105, 0.072),
      horizonRidge(azimuth, 0.185, 0.112, 0.067)
    );
    middlePeak = 0.002 + max(
      horizonRidge(azimuth, -0.197, 0.073, 0.047),
      max(horizonRidge(azimuth, 0.135, 0.075, 0.043), horizonRidge(azimuth, 0.066, 0.048, 0.028))
    );
    nearPeak = max(
      horizonRidge(azimuth, -0.215, 0.065, 0.034),
      horizonRidge(azimuth, 0.215, 0.061, 0.028)
    );
  } else {
    farPeak = 0.005 + max(
      max(horizonRidge(azimuth, -0.64, 0.32, 0.108), horizonRidge(azimuth, -0.32, 0.17, 0.075)),
      max(
        max(horizonRidge(azimuth, 0.47, 0.27, 0.108), horizonRidge(azimuth, 0.75, 0.13, 0.052)),
        horizonRidge(azimuth, 0.035, 0.12, 0.038)
      )
    );
    middlePeak = 0.004 + max(
      max(horizonRidge(azimuth, -0.72, 0.24, 0.078), horizonRidge(azimuth, -0.235, 0.14, 0.052)),
      max(
        max(horizonRidge(azimuth, 0.42, 0.20, 0.067), horizonRidge(azimuth, 0.71, 0.14, 0.066)),
        horizonRidge(azimuth, 0.16, 0.095, 0.037)
      )
    );
    nearPeak = max(
      max(horizonRidge(azimuth, -0.57, 0.18, 0.052), horizonRidge(azimuth, -0.27, 0.12, 0.032)),
      max(horizonRidge(azimuth, 0.55, 0.14, 0.053), horizonRidge(azimuth, 0.28, 0.15, 0.030))
    );
  }

  // Three scales roughen each crest without making an angular skyline.
  float farDetail = horizonNoise(vec2(azimuth * 18.0 + seed, 4.7)) * 0.60
    + horizonNoise(vec2(azimuth * 52.0, seed + 8.0)) * 0.30
    + horizonNoise(vec2(azimuth * 109.0, seed + 3.0)) * 0.10;
  farPeak += (farDetail - 0.5) * 0.031;
  middlePeak += (horizonNoise(vec2(azimuth * 38.0 - seed, 22.1)) - 0.5) * 0.024;
  nearPeak += (horizonNoise(vec2(azimuth * 54.0 + seed, 53.9)) - 0.5) * 0.016;

  return vec3(farPeak, middlePeak, nearPeak);
}
float distantLightVisibility(vec3 direction, float seed, float mobile) {
  // All procedural crests lie below this elevation; ordinary daylight/night
  // avoids evaluating the ridge noise at every shaded surface pixel.
  if (direction.y > 0.16) return 1.0;
  if (direction.y < -0.02) return 0.0;
  vec3 peaks = distantPeaks(atan(direction.x, -direction.z), seed, mobile);
  float crest = max(0.0, max(peaks.x, max(peaks.y, peaks.z)));
  // A finite angular disc emerges progressively over the ridge.
  return smoothstep(crest - 0.009, crest + 0.009, direction.y);
}
`
