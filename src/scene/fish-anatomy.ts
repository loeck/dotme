import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

export type FishSpecies = 'carp' | 'roach' | 'perch'

const smooth = (a: number, b: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Low-poly spindle, thin fins and a forked vertical tail. Local +Z is forward. */
export function createFishGeometry(species: FishSpecies) {
  const width = species === 'roach' ? 0.25 : species === 'perch' ? 0.29 : 0.33
  const height = species === 'perch' ? 0.27 : 0.23
  const rings = [
    [0.5, 0.1, 0.1],
    [0.38, width * 0.7, height * 0.8],
    [0.14, width, height],
    [-0.12, width * 0.85, height * 0.88],
    [-0.34, width * 0.44, height * 0.48],
    [-0.51, 0.055, 0.075],
  ] as const
  const vertices: number[] = []
  type Point = readonly [number, number, number]
  const triangle = (a: Point, b: Point, c: Point) => vertices.push(...a, ...b, ...c)
  const point = (ring: (typeof rings)[number], side: number): Point => {
    const angle = (side / 8) * Math.PI * 2
    return [Math.cos(angle) * ring[1], Math.sin(angle) * ring[2], ring[0]]
  }
  for (let ring = 0; ring < rings.length - 1; ring++)
    for (let side = 0; side < 8; side++) {
      const a = point(rings[ring]!, side),
        b = point(rings[ring]!, side + 1)
      const c = point(rings[ring + 1]!, side),
        d = point(rings[ring + 1]!, side + 1)
      triangle(a, c, b)
      triangle(b, c, d)
    }
  for (let side = 0; side < 8; side++) {
    triangle([0, 0, 0.55], point(rings[0], side), point(rings[0], side + 1))
    triangle([0, 0, -0.54], point(rings[5], side + 1), point(rings[5], side))
  }
  // Two swept lobes, leaving a real notch in the trailing edge.
  for (const sign of [-1, 1]) {
    triangle([0, sign * 0.04, -0.48], [0, sign * 0.31, -0.81], [0, sign * 0.07, -0.72])
    triangle([0, sign * 0.04, -0.48], [0, sign * 0.07, -0.72], [0, 0, -0.61])
    triangle(
      [sign * width * 0.65, -0.07, 0.17],
      [sign * width * 1.65, -0.16, -0.13],
      [sign * width * 0.65, -0.13, -0.02],
    )
  }
  triangle([0, height * 0.8, 0.12], [0, height + 0.16, -0.13], [0, height * 0.55, -0.34])
  const body = new BufferGeometry()
  body.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  body.computeVertexNormals()
  const normals = body.getAttribute('normal')
  const colors = new Float32Array(vertices.length)
  const back = new Color(0x9db4b7),
    flank = new Color(0x2b4552),
    belly = new Color(0x789092)
  for (let i = 0; i < normals.count; i++) {
    const up = normals.getY(i)
    const color = flank.clone().lerp(up >= 0 ? back : belly, Math.abs(up) * 0.85)
    colors.set([color.r, color.g, color.b], i * 3)
  }
  body.setAttribute('color', new Float32BufferAttribute(colors, 3))
  const parts = [body]
  for (const sign of [-1, 1]) {
    const eye = new BoxGeometry(0.024, 0.043, 0.043).toNonIndexed()
    eye.deleteAttribute('uv')
    eye.translate(sign * width * 0.72, 0.05, 0.38)
    const color = new Color(0x12242b)
    const values = Array.from({ length: eye.getAttribute('position').count }, () => [
      color.r,
      color.g,
      color.b,
    ]).flat()
    eye.setAttribute('color', new Float32BufferAttribute(values, 3))
    parts.push(eye)
  }
  const geometry = mergeGeometries(parts)!
  for (const part of parts) part.dispose()
  const positions = geometry.getAttribute('position')
  const weights: number[] = []
  for (let i = 0; i < positions.count; i++) {
    const z = positions.getZ(i)
    weights.push(1 - smooth(-0.08, 0.3, z), 1 - smooth(-0.4, -0.12, z), 1 - smooth(-0.6, -0.44, z))
  }
  geometry.setAttribute('aFishJoints', new Float32BufferAttribute(weights, 3))
  geometry.name = `Articulated ${species} shoal`
  return geometry
}

/** Three nested joints behind a stable head, shared by positions and normals. */
export const FISH_RIG_GLSL = `
attribute vec3 aFishJoints;
attribute float aFishPhase;
attribute vec3 aFishMotion;
vec3 fishJoint(vec3 point, float pivot, float angle, bool normalOnly) {
  if (!normalOnly) point.z -= pivot;
  float c = cos(angle), s = sin(angle);
  point.xz = mat2(c, -s, s, c) * point.xz;
  if (!normalOnly) point.z += pivot;
  return point;
}
vec3 fishRig(vec3 point, bool normalOnly) {
  // Swim in physical proportions: the slender instance scale previously
  // compressed lateral tail displacement until the whole fish looked rigid.
  float aspect = max(0.1, aFishMotion.z);
  point.x *= normalOnly ? 1.0 / aspect : aspect;
  float effort = aFishMotion.x;
  float turn = aFishMotion.y;
  float body = sin(aFishPhase) * 0.16 * effort + turn * 0.16;
  float rear = sin(aFishPhase - 0.85) * 0.40 * effort + turn * 0.22;
  float tail = sin(aFishPhase - 1.65) * 0.70 * effort + turn * 0.18;
  // Distal joints first; parent rotations carry both the child and its pivot.
  point = fishJoint(point, -0.51, tail * aFishJoints.z, normalOnly);
  point = fishJoint(point, -0.25, rear * aFishJoints.y, normalOnly);
  point = fishJoint(point, 0.18, body * aFishJoints.x, normalOnly);
  point.x *= normalOnly ? aspect : 1.0 / aspect;
  return point;
}
`
