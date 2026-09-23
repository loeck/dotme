import { PlaneGeometry } from 'three'

import { LAKE_BOUNDS } from './lake-bed'

const WAVES = [
  [0.83, 0.56, 18, 0.016],
  [-0.46, 0.89, 7, 0.008],
  [0.25, 0.968, 1.4, 0.002],
  [-0.6, 0.8, 0.65, 0.0008],
] as const

export function swellHeight(x: number, z: number, time: number) {
  return WAVES.reduce((height, [dx, dz, wavelength, amplitude]) => {
    const k = (Math.PI * 2) / wavelength
    return height + Math.sin((x * dx + z * dz) * k - Math.sqrt(9.81 * k) * time) * amplitude
  }, 0)
}

/** Identical field in vertex displacement, fragment derivatives, and the CPU picking swell. */
export const WATER_FIELD_GLSL = `
uniform sampler2D uState;
uniform sampler2D uMask;
uniform float uTime;
uniform float uCell;
vec2 fieldUv(vec2 p) { return (p - vec2(${LAKE_BOUNDS.minX.toFixed(1)}, ${LAKE_BOUNDS.minZ.toFixed(1)})) / ${LAKE_BOUNDS.size.toFixed(1)}; }
float heightAt(vec2 p, float footprint) {
  vec2 uv = fieldUv(p);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  float wet = mix(1.0, step(0.5, texture2D(uMask, uv).r), inside);
  float h = texture2D(uState, clamp(uv, 0.0, 1.0)).r * inside;
  ${WAVES.map(([dx, dz, length, amplitude]) => {
    const k = (Math.PI * 2) / length
    return `h += sin(dot(p, vec2(${dx}, ${dz})) * ${k} - uTime * ${Math.sqrt(9.81 * k)}) * ${amplitude} * (1.0 - smoothstep(${(length * 0.2).toFixed(6)}, ${(length * 0.5).toFixed(6)}, footprint));`
  }).join('\n')}
  return h * wet;
}
`

/** More triangles in the near lake; the outer surface still reaches beyond the horizon. */
export function createWaterGeometry(mobile: boolean) {
  const segments = mobile ? 192 : 384
  const geometry = new PlaneGeometry(1, 1, segments, segments)
  const positions = geometry.attributes.position!
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i) * 2
    const t = 0.5 + positions.getY(i)
    positions.setXYZ(i, Math.sign(x) * Math.abs(x) ** 2.6 * 500, -(24 - t ** 2.6 * 524), 0)
  }
  geometry.computeBoundingSphere()
  return geometry
}
