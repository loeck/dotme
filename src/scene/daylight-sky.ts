/** Atmospheric portion adapted from Three.js r186 Sky (MIT, three.js authors).
 * Preetham coefficients and optical air mass; no projected 2D cloud layer.
 * Radiance stays linear until the final lens pass applies tone mapping.
 */
export const DAYLIGHT_SKY_GLSL = `
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uDaylight;
uniform float uShowSun;
uniform vec3 uHaze;
float opticalAirMass(float elevation) {
  float zenith = acos(clamp(elevation, 0.0, 1.0));
  return 1.0 / (cos(zenith) + 0.15 * pow(93.885 - degrees(zenith), -1.253));
}
vec3 daylightSky(vec3 ray) {
  vec3 betaR = vec3(5.804543e-6, 1.356291e-5, 3.026590e-5);
  vec3 betaM = vec3(1.839992e14, 2.779802e14, 4.079048e14) * 0.434 * 4e-18 * 0.005;
  vec3 extinction = exp(-(betaR * 8400.0 + betaM * 1250.0) * opticalAirMass(ray.y));
  float cosine = dot(ray, uSunDirection);
  float rayleigh = 0.0596831 * (1.0 + cosine * cosine);
  float mie = 0.0795775 * 0.36 / pow(1.64 - 1.6 * cosine, 1.5);
  vec3 solarTransmission = exp(-(betaR * 8400.0 + betaM * 1250.0) * opticalAirMass(uSunDirection.y));
  vec3 scattered = 14.0 * ((betaR * rayleigh + betaM * mie) / (betaR + betaM))
    * (1.0 - extinction) * mix(vec3(1.0), solarTransmission, 0.7);
  float disc = smoothstep(0.99994, 0.99996, cosine) * uShowSun;
  return scattered + disc * uSunColor * uSunIntensity * 12.0;
}
`
