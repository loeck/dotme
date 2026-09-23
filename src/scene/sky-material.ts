import { BackSide, ShaderMaterial, Vector3 } from 'three'

// The landscape is close to the camera; these distant silhouettes give the
// valley depth without adding another band of visible geometry at the shore.
const vertexShader = `
varying vec3 vDirection;
void main() {
  vDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // The sky is infinitely distant, including in the lake's oblique reflection
  // camera. Clipping this finite sphere against the water plane leaves a black
  // strip where reflected rays meet the lake beyond the sphere's radius.
  gl_Position.z = gl_Position.w;
}
`

const fragmentShader = `
uniform float uTime;
uniform float uSeed;
uniform float uMobile;
uniform vec3 uMoonDirection;
uniform float uMoonIntensity;
varying vec3 vDirection;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float ridge(float x, float centre, float width, float height) {
  float distanceFromPeak = (x - centre) / width;
  return height * exp(-distanceFromPeak * distanceFromPeak);
}

void main() {
  vec3 direction = normalize(vDirection);
  float azimuth = atan(direction.x, -direction.z);
  float elevation = direction.y;

  // A faint pool of light follows the open water, with an irregular upper edge.
  // Its narrow height keeps the rest of the sky nearly black.
  float horizonNoise = noise(vec2(azimuth * 7.0 + uSeed, 8.0));
  float horizon = exp(-pow((elevation - 0.018 - (horizonNoise - 0.5) * 0.012) * 12.0, 2.0));
  float valleyLight = exp(-pow((azimuth - 0.08) / 0.46, 2.0));
  vec3 color = mix(
    vec3(0.0026, 0.0038, 0.0051),
    vec3(0.012, 0.018, 0.027),
    horizon * (0.58 + 0.27 * horizonNoise + 0.15 * valleyLight)
  );

  // Cloud wisps make the lower sky less uniform without a bright, continuous band.
  float drift = uTime * 0.011;
  float cloudBand = exp(-pow((elevation - 0.155) * 12.0, 2.0));
  float cloudShape = noise(vec2(azimuth * 11.0 + drift + uSeed, elevation * 14.0 + 3.7));
  float cloudDetail = noise(vec2(
    azimuth * 28.0 - drift * 0.6 + cloudShape * 0.8,
    elevation * 35.0 + uSeed
  ));
  float cloud = smoothstep(0.34, 0.68, cloudShape * 0.65 + cloudDetail * 0.35);
  color = mix(color, vec3(0.018, 0.026, 0.034), cloud * cloudBand * 0.13);

  // Separate hills overlap at different bearings. Avoid a mirrored valley
  // function, which reads as two diagonal wedges at narrow viewports.
  float farPeak;
  float middlePeak;
  float nearPeak;
  if (uMobile > 0.5) {
    farPeak = 0.004 + max(
      ridge(azimuth, -0.165, 0.105, 0.072),
      ridge(azimuth, 0.185, 0.112, 0.067)
    );
    middlePeak = 0.002 + max(
      ridge(azimuth, -0.197, 0.073, 0.047),
      max(ridge(azimuth, 0.135, 0.075, 0.043), ridge(azimuth, 0.066, 0.048, 0.028))
    );
    nearPeak = max(
      ridge(azimuth, -0.215, 0.065, 0.034),
      ridge(azimuth, 0.215, 0.061, 0.028)
    );
  } else {
    farPeak = 0.005 + max(
      max(ridge(azimuth, -0.64, 0.32, 0.108), ridge(azimuth, -0.32, 0.17, 0.075)),
      max(
        max(ridge(azimuth, 0.47, 0.27, 0.108), ridge(azimuth, 0.75, 0.13, 0.052)),
        ridge(azimuth, 0.035, 0.12, 0.038)
      )
    );
    middlePeak = 0.004 + max(
      max(ridge(azimuth, -0.72, 0.24, 0.078), ridge(azimuth, -0.235, 0.14, 0.052)),
      max(
        max(ridge(azimuth, 0.42, 0.20, 0.067), ridge(azimuth, 0.71, 0.14, 0.066)),
        ridge(azimuth, 0.16, 0.095, 0.037)
      )
    );
    nearPeak = max(
      max(ridge(azimuth, -0.57, 0.18, 0.052), ridge(azimuth, -0.27, 0.12, 0.032)),
      max(ridge(azimuth, 0.55, 0.14, 0.053), ridge(azimuth, 0.28, 0.15, 0.030))
    );
  }

  // Three scales roughen each crest without making an angular skyline.
  float farDetail = noise(vec2(azimuth * 18.0 + uSeed, 4.7)) * 0.60
    + noise(vec2(azimuth * 52.0, uSeed + 8.0)) * 0.30
    + noise(vec2(azimuth * 109.0, uSeed + 3.0)) * 0.10;
  farPeak += (farDetail - 0.5) * 0.031;
  middlePeak += (noise(vec2(azimuth * 38.0 - uSeed, 22.1)) - 0.5) * 0.024;
  nearPeak += (noise(vec2(azimuth * 54.0 + uSeed, 53.9)) - 0.5) * 0.016;

  // Keep the crests legible as the ridge feet dissolve into the low mist.
  // A tall base fade erased the smaller hills and flattened the entire valley.
  float baseFade = smoothstep(-0.008, 0.026, elevation);
  float farEdge = 1.0 - smoothstep(farPeak - 0.006, farPeak + 0.009, elevation);
  color = mix(color, vec3(0.0078, 0.0123, 0.0188), farEdge * baseFade * 0.88);

  // A wavering low veil pools in the open valley and softens only the far ridge.
  float mistShape = noise(vec2(azimuth * 13.0 + drift * 0.8, uSeed + 73.0));
  float mistHeight = 0.033 + (mistShape - 0.5) * 0.024;
  float farMist = exp(-pow((elevation - mistHeight) * 28.0, 2.0));
  float valleyPool = exp(-pow((azimuth - 0.13) / 0.32, 2.0));
  color = mix(
    color,
    vec3(0.018, 0.026, 0.037),
    farMist * (0.08 + mistShape * 0.13 + valleyPool * 0.36)
  );

  float middleEdge = 1.0 - smoothstep(middlePeak - 0.004, middlePeak + 0.006, elevation);
  color = mix(color, vec3(0.0053, 0.0085, 0.0131), middleEdge * baseFade * 0.91);
  float nearEdge = 1.0 - smoothstep(nearPeak - 0.003, nearPeak + 0.004, elevation);
  color = mix(color, vec3(0.0031, 0.0051, 0.0081), nearEdge * baseFade * 0.86);

  // Thin, uneven mist separates the ridge layers close to the waterline.
  float lowMist = exp(-pow((elevation - 0.006) * 42.0, 2.0));
  float mistNoise = noise(vec2(azimuth * 18.0 + drift * 0.8, elevation * 35.0 + 73.0));
  float mistDetail = noise(vec2(azimuth * 43.0 - drift, elevation * 24.0 + uSeed));
  float mist = lowMist * (0.12 + mistNoise * 0.16 + mistDetail * 0.055 + valleyPool * 0.22);
  color = mix(color, vec3(0.023, 0.033, 0.044), mist);

  // The visible moon and its halo track the same direction as the scene light.
  float moonAngle = acos(clamp(dot(direction, uMoonDirection), -1.0, 1.0));
  float moonDisc = 1.0 - smoothstep(0.008, 0.010, moonAngle);
  float moonHalo = exp(-moonAngle * moonAngle * 90.0) * 0.016;
  color += vec3(0.63, 0.77, 1.0) * (moonDisc * 2.0 + moonHalo) * uMoonIntensity;
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export function createSkyMaterial(seed: number, mobile = false): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uMoonDirection: { value: new Vector3(-35, 48, -20).normalize() },
      uMoonIntensity: { value: 1.5 },
      uSeed: { value: (seed % 4096) / 379 },
      uMobile: { value: mobile ? 1 : 0 },
    },
    side: BackSide,
    depthWrite: false,
    fog: false,
  })
}
