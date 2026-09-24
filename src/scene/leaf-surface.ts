import { BufferGeometry, Float32BufferAttribute } from 'three'

/** A continuous blade: pointed tip, asymmetric serrations, folded midrib and petiole. */
export function createLeafGeometry() {
  const positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = []
  const rows = 32,
    columns = 8
  for (let row = 0; row <= rows; row++) {
    const t = row / rows
    const envelope = Math.pow(Math.sin(Math.PI * t), 0.78) * (0.74 - t * 0.17)
    for (let col = 0; col <= columns; col++) {
      const across = (col / columns) * 2 - 1
      const edge =
        1 +
        Math.abs(across) ** 5 *
          (0.045 * Math.sin((row * Math.PI) / 2) + 0.025 * Math.sin(row * 2.7 + Math.sign(across)))
      const x = across * Math.max(0.002, envelope) * edge + 0.055 * Math.sin(t * Math.PI) ** 2
      const y =
        0.007 * (1 - Math.abs(across)) +
        0.024 * across ** 2 * Math.sin(t * Math.PI) +
        0.027 * t ** 5
      positions.push(x, y, -0.78 + t * 1.78)
      uvs.push(col / columns, t)
      if (row < rows && col < columns) {
        const a = row * (columns + 1) + col,
          b = a + columns + 1
        indices.push(a, b, a + 1, a + 1, b, b + 1)
      }
    }
  }
  const stem = positions.length / 3
  positions.push(-0.014, 0.006, -0.78, 0.014, 0.006, -0.78, 0.029, 0.015, -1, 0.012, 0.015, -1)
  uvs.push(0.48, 0, 0.52, 0, 0.52, -0.12, 0.48, -0.12)
  indices.push(stem, stem + 1, stem + 2, stem, stem + 2, stem + 3)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

// Filter every vein at its projected pixel width: fine detail should disappear
// gracefully at the low water-view angle instead of sparkling as the leaf drifts.
export const LEAF_SURFACE_GLSL = `
varying vec2 vLeafUv;
varying vec2 vLeafTraits;
float leafNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec4 corners = fract(sin(vec4(dot(i, vec2(127.1, 311.7)), dot(i + vec2(1, 0), vec2(127.1, 311.7)), dot(i + vec2(0, 1), vec2(127.1, 311.7)), dot(i + vec2(1), vec2(127.1, 311.7)))) * 43758.5453);
  return mix(mix(corners.x, corners.y, f.x), mix(corners.z, corners.w, f.x), f.y);
}
float leafLine(float distance, float width) {
  float pixel = max(fwidth(distance), 0.0001);
  return (1.0 - smoothstep(width, width + pixel, distance)) * min(1.0, width / pixel);
}
`

export const LEAF_COLOR_GLSL = `
vec2 leafUv = vLeafUv;
float across = abs(leafUv.x * 2.0 - 1.0);
float midrib = leafLine(across, 0.028);
float branchPhase = leafUv.y * 8.0 - across * (1.45 - leafUv.y * 0.5) + step(0.5, leafUv.x) * 0.23;
float branchDistance = abs(fract(branchPhase + 0.5) - 0.5);
float branches = leafLine(branchDistance, 0.032) * smoothstep(0.02, 0.15, across) * (1.0 - smoothstep(0.78, 1.0, across));
float veins = max(midrib, branches * 0.65);
float mottling = leafNoise(leafUv * vec2(7.0, 13.0) + vLeafTraits.y * 19.0);
float patches = leafNoise(leafUv * vec2(3.0, 6.0) + vLeafTraits.y * 7.0);
float dryEdge = smoothstep(0.75 + patches * 0.18, 1.0, across);
float speckleScale = max(length(fwidth(leafUv * vec2(31.0, 53.0))), 0.001);
float freckles = smoothstep(0.68, 0.86, leafNoise(leafUv * vec2(31.0, 53.0) + vLeafTraits.y));
freckles *= 1.0 - smoothstep(0.35, 1.2, speckleScale);
float aging = smoothstep(0.48, 0.82, patches) * (0.3 + across * 0.7);
diffuseColor.rgb *= 0.7 + patches * 0.46 + mottling * 0.16;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.7, 0.47, 0.26), aging * 0.5 + freckles * 0.38);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.68, 0.48, 0.28), dryEdge * 0.6);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.24 + vec3(0.045, 0.032, 0.008), veins * 0.7);
if (leafUv.y < 0.0) diffuseColor.rgb = vec3(0.16, 0.09, 0.025);
`

export const LEAF_NORMAL_GLSL = `
// Geometric normal includes the actual shared water displacement and curled blade.
vec3 leafDx = dFdx(-vViewPosition), leafDy = dFdy(-vViewPosition);
normal = normalize(cross(leafDx, leafDy));
float relief = midrib * 0.0012 + branches * 0.0005;
vec3 leafR1 = cross(leafDy, normal), leafR2 = cross(normal, leafDx);
float leafDet = dot(leafDx, leafR1);
vec3 leafGradient = sign(leafDet) * (dFdx(relief) * leafR1 + dFdy(relief) * leafR2);
normal = normalize(abs(leafDet) * normal - leafGradient);
`
