import { WATER_LEVEL } from './lake-bed'
import { sampleHeight, sampleNormal, sampleRock } from './terrain-field'
import type { TerrainField, TerrainIsland } from './terrain-field'

/**
 * Granite boulders: the single stones of the voxel composition, rocky slopes, the waterline and a
 * few glacial erratics on open ground, as on Nordic lake shores. Each is a cleaved, weathered
 * icosphere partly buried in the ground; instances are merged into one static mesh.
 */
export type Boulder = Readonly<{
  x: number
  y: number
  z: number
  /** Half extents before rotation: across, up, along. */
  size: readonly [number, number, number]
  yaw: number
  /** Unit ground normal the boulder leans toward (half way). */
  up: readonly [number, number, number]
  variant: number
  /** 0..1 albedo tone and moss bias, hashed per boulder. */
  tone: number
  moss: number
}>

export type BoulderAvoid = Readonly<{ x: number; z: number; radius: number }>

export type BoulderFall = Readonly<{
  x: number
  z: number
  width: number
  direction: readonly [number, number]
  basin: readonly Readonly<{ x: number; z: number; size: number }>[]
}>

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const mix = (a: number, b: number, t: number) => a + (b - a) * t

function hash(seed: number, x: number, z: number, stream: number) {
  let n =
    Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(stream, 0x9e3779b1)
  n = Math.imul(n ^ seed ^ (n >>> 15), 0x2c1b3c6d)
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39)
  return ((n ^ (n >>> 15)) >>> 0) / 0x1_0000_0000
}

export const BOULDER_VARIANTS = 8

export function placeBoulders(
  field: TerrainField,
  islands: readonly TerrainIsland[],
  seed: number,
  mobile: boolean,
  avoid: readonly BoulderAvoid[],
  fall: BoulderFall | null,
): Boulder[] {
  const budget = mobile ? 90 : 320
  const boulders: Boulder[] = []
  const fallBlocks = (x: number, z: number, radius: number) => {
    if (!fall) return false
    const [nx, nz] = fall.direction
    const along = (x - fall.x) * nx + (z - fall.z) * nz
    const across = (x - fall.x) * nz - (z - fall.z) * nx
    // The sheet's corridor and its landing stay clear, with a wider berth in front of the lip:
    // the coarse mobile lake raster (0.6 m cells) must still see open water at the landing.
    if (Math.abs(across) < fall.width / 2 + (along > 0 ? 1.1 : 0.45) && along > -0.6 && along < 2.4)
      return true
    // No stone's waterline may reach into the landing's raster cells either.
    const outside = Math.hypot(
      Math.max(0, 0.2 - along, along - 1.4),
      Math.max(0, Math.abs(across) - fall.width / 2 - 0.65),
    )
    return outside < radius * 1.3
  }
  const free = (x: number, z: number, radius: number) =>
    !fallBlocks(x, z, radius) &&
    avoid.every((area) => Math.hypot(x - area.x, z - area.z) > area.radius + radius) &&
    boulders.every(
      (other) =>
        Math.hypot(x - other.x, z - other.z) >
        (Math.max(other.size[0], other.size[2]) + radius) * 0.8,
    )
  const add = (
    x: number,
    z: number,
    width: number,
    height: number,
    bury: number,
    key: number,
    lean = 0.5,
  ) => {
    if (boulders.length >= budget) return false
    const radius = width
    if (!free(x, z, radius)) return false
    const ground = Math.min(
      sampleHeight(field, x, z),
      sampleHeight(field, x + radius * 0.7, z),
      sampleHeight(field, x - radius * 0.7, z),
      sampleHeight(field, x, z + radius * 0.7),
      sampleHeight(field, x, z - radius * 0.7),
    )
    const normal = sampleNormal(field, x, z)
    const up: [number, number, number] = [
      normal[0] * lean,
      mix(1, normal[1], lean),
      normal[2] * lean,
    ]
    const length = Math.hypot(up[0], up[1], up[2])
    const aspect = mix(0.75, 1.25, hash(seed, key, 3, 71))
    boulders.push({
      x,
      y: ground + height * (1 - 2 * bury),
      z,
      size: [width * aspect, height, width / aspect],
      yaw: hash(seed, key, 5, 73) * Math.PI * 2,
      up: [up[0] / length, up[1] / length, up[2] / length],
      variant: Math.floor(hash(seed, key, 7, 79) * BOULDER_VARIANTS),
      tone: hash(seed, key, 11, 83),
      moss: hash(seed, key, 13, 89),
    })
    return true
  }

  // 1. The composition's single stones, half out of the water, where the voxels put them.
  islands.forEach((island, index) => {
    const width = clamp(island.extent * 0.75, 0.2, 0.62) * mix(0.9, 1.35, hash(seed, index, 1, 97))
    // Low, flat-topped stones, as waves and ice leave them.
    const height = clamp(Math.max(island.top - WATER_LEVEL, 0.05) * 0.75 + width * 0.18, 0.1, 0.38)
    const top = island.top + 0.03
    if (!free(island.x, island.z, width * 0.8) || boulders.length >= budget) return
    // Like the voxel column it replaces, the stone reaches well below the wave trough.
    const bottom = Math.min(top - height * 2, WATER_LEVEL - 0.6)
    const halfHeight = (top - bottom) / 2
    const normal: [number, number, number] = [0, 1, 0]
    const aspect = mix(0.8, 1.25, hash(seed, index, 3, 101))
    boulders.push({
      x: island.x,
      y: top - halfHeight,
      z: island.z,
      size: [width * aspect, halfHeight, width / aspect],
      yaw: hash(seed, index, 5, 103) * Math.PI * 2,
      up: normal,
      variant: Math.floor(hash(seed, index, 7, 107) * BOULDER_VARIANTS),
      tone: hash(seed, index, 11, 109),
      moss: hash(seed, index, 13, 113) * 0.6,
    })
  })

  // 2. Large stones flank the fall down to its plunge, so the carved face reads as a gorge in
  // broken rock rather than a cut block; then a few frame the basin, never in front of the lip.
  if (fall) {
    const [nx, nz] = fall.direction
    for (const side of [-1, 1])
      for (let k = 0; k < 4; k++) {
        const i = (side + 1) * 8 + k
        const across = side * (fall.width / 2 + 0.6 + k * 0.42 + hash(seed, i, 47, 179) * 0.2)
        const along = mix(-0.5, 0.9, hash(seed, i, 53, 181))
        add(
          fall.x + nz * across + nx * along,
          fall.z - nx * across + nz * along,
          mix(0.38, 0.72, hash(seed, i, 59, 191)),
          mix(0.32, 0.6, hash(seed, i, 61, 193)),
          0.22,
          8000 + i,
          0.25,
        )
      }
  }
  if (fall) {
    const [nx, nz] = fall.direction
    fall.basin.forEach((cell, index) => {
      if (hash(seed, index, 17, 127) < 0.55) return
      const angle = hash(seed, index, 19, 131) * Math.PI * 2
      const reach = cell.size * 1.3
      const x = cell.x + Math.cos(angle) * reach,
        z = cell.z + Math.sin(angle) * reach
      // Only behind or beside the lip, so the sheet and its approach stay open.
      if ((x - fall.x) * nx + (z - fall.z) * nz > -0.25) return
      add(
        x,
        z,
        mix(0.25, 0.48, hash(seed, index, 23, 137)),
        mix(0.2, 0.36, hash(seed, index, 29, 139)),
        0.25,
        9000 + index,
        0.3,
      )
    })
  }

  // 3. Candidates on a jittered 1 m lattice, ranked by a seeded hash so the result is
  // independent of iteration order.
  type Candidate = { x: number; z: number; key: number; rank: number; kind: 0 | 1 | 2 }
  const candidates: Candidate[] = []
  const step = mobile ? 1.1 : 0.9
  const x0 = field.minX + 1,
    z0 = field.minZ + 1
  const x1 = field.minX + (field.columns - 2) * field.cell,
    z1 = field.minZ + (field.rows - 2) * field.cell
  let key = 0
  for (let z = z0; z < z1; z += step)
    for (let x = x0; x < x1; x += step) {
      key++
      const jx = x + (hash(seed, key, 31, 149) - 0.5) * step
      const jz = z + (hash(seed, key, 37, 151) - 0.5) * step
      const h = sampleHeight(field, jx, jz)
      if (h < WATER_LEVEL - 0.25) continue
      const normal = sampleNormal(field, jx, jz)
      const slope = 1 - normal[1]
      const rock = sampleRock(field, jx, jz)
      // Clustered: a slow field gathers stones into screes and fields.
      const cluster =
        hash(seed, Math.floor(jx / 6), Math.floor(jz / 6), 157) * 0.6 +
        hash(seed, Math.floor(jx / 2.5), Math.floor(jz / 2.5), 163) * 0.4
      const roll = hash(seed, key, 41, 167)
      if (h < 0.14) {
        // Waterline stones, mostly where the bank is rocky.
        if (roll < 0.86 - rock * 0.25 - cluster * 0.12) continue
        candidates.push({ x: jx, z: jz, key, rank: roll * cluster, kind: 0 })
      } else if (slope > 0.12 || rock > 0.35) {
        // Rocky ground and steep faces: outcrops and scree.
        if (roll < 0.9 - rock * 0.35 - slope * 0.4 - cluster * 0.1) continue
        candidates.push({ x: jx, z: jz, key, rank: roll * (0.5 + cluster), kind: 1 })
      } else if (roll > 0.988 - cluster * 0.01) {
        // Rare glacial erratics on open ground.
        candidates.push({ x: jx, z: jz, key, rank: roll, kind: 2 })
      }
    }
  candidates.sort((a, b) => b.rank - a.rank || a.key - b.key)
  for (const candidate of candidates) {
    if (boulders.length >= budget) break
    const r = hash(seed, candidate.key, 43, 173)
    const depth = clamp((-candidate.z - 10) / 40, 0, 1)
    if (candidate.kind === 0)
      add(candidate.x, candidate.z, mix(0.14, 0.42, r * r), mix(0.1, 0.26, r), 0.3, candidate.key)
    else if (candidate.kind === 1) {
      const scale = mix(1, 1.6, depth)
      add(
        candidate.x,
        candidate.z,
        mix(0.18, 0.62, r * r) * scale,
        mix(0.14, 0.42, r) * scale,
        0.38,
        candidate.key,
        0.7,
      )
    } else add(candidate.x, candidate.z, mix(0.55, 1.05, r), mix(0.4, 0.7, r), 0.32, candidate.key)
  }
  return boulders
}

/** An indexed icosphere, subdivided `detail` times. */
function icosphere(detail: number) {
  const t = (1 + Math.sqrt(5)) / 2
  const positions: number[] = [
    -1,
    t,
    0,
    1,
    t,
    0,
    -1,
    -t,
    0,
    1,
    -t,
    0,
    0,
    -1,
    t,
    0,
    1,
    t,
    0,
    -1,
    -t,
    0,
    1,
    -t,
    t,
    0,
    -1,
    t,
    0,
    1,
    -t,
    0,
    -1,
    -t,
    0,
    1,
  ]
  let faces: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
    8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ]
  for (let level = 0; level < detail; level++) {
    const midpoints = new Map<string, number>()
    const midpoint = (a: number, b: number) => {
      const name = a < b ? `${a}:${b}` : `${b}:${a}`
      const known = midpoints.get(name)
      if (known !== undefined) return known
      const index = positions.length / 3
      positions.push(
        ((positions[a * 3] ?? 0) + (positions[b * 3] ?? 0)) / 2,
        ((positions[a * 3 + 1] ?? 0) + (positions[b * 3 + 1] ?? 0)) / 2,
        ((positions[a * 3 + 2] ?? 0) + (positions[b * 3 + 2] ?? 0)) / 2,
      )
      midpoints.set(name, index)
      return index
    }
    const next: number[] = []
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f] ?? 0,
        b = faces[f + 1] ?? 0,
        c = faces[f + 2] ?? 0
      const ab = midpoint(a, b),
        bc = midpoint(b, c),
        ca = midpoint(c, a)
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca)
    }
    faces = next
  }
  for (let i = 0; i < positions.length; i += 3) {
    const length = Math.hypot(positions[i] ?? 0, positions[i + 1] ?? 0, positions[i + 2] ?? 0)
    positions[i] = (positions[i] ?? 0) / length
    positions[i + 1] = (positions[i + 1] ?? 0) / length
    positions[i + 2] = (positions[i + 2] ?? 0) / length
  }
  return { positions: new Float32Array(positions), indices: Uint32Array.from(faces) }
}

/**
 * A unit boulder: lumpy low-frequency swelling, several cleavage planes that cut flat, slightly
 * rounded facets (weathered granite splits along joints), and a flattened, buried underside.
 */
export function boulderShape(variant: number, seed: number, detail = 2) {
  const { positions, indices } = icosphere(detail)
  const random = (stream: number, i: number) => hash(seed, variant, i, stream)
  const bumps = Array.from({ length: 6 }, (_, i) => {
    const theta = random(201, i) * Math.PI * 2,
      phi = Math.acos(random(203, i) * 2 - 1)
    return {
      d: [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)] as const,
      a: (random(207, i) - 0.4) * 0.32,
    }
  })
  const planes = Array.from({ length: 5 + Math.floor(random(211, 0) * 4) }, (_, i) => {
    const theta = random(213, i) * Math.PI * 2,
      phi = Math.acos(random(217, i) * 1.6 - 0.8)
    return {
      d: [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)] as const,
      offset: 0.72 + random(219, i) * 0.2,
    }
  })
  for (let i = 0; i < positions.length; i += 3) {
    let x = positions[i] ?? 0,
      y = positions[i + 1] ?? 0,
      z = positions[i + 2] ?? 0
    let k = 1
    for (const bump of bumps) {
      const dot = x * bump.d[0] + y * bump.d[1] + z * bump.d[2]
      k += bump.a * Math.exp((dot - 1) * 3.5)
    }
    x *= k
    y *= k
    z *= k
    for (const plane of planes) {
      const dot = x * plane.d[0] + y * plane.d[1] + z * plane.d[2]
      if (dot > plane.offset) {
        // Pull onto the plane, leaving a slight bulge so facets are not perfectly flat.
        const excess = (dot - plane.offset) * 0.92
        x -= plane.d[0] * excess
        y -= plane.d[1] * excess
        z -= plane.d[2] * excess
      }
    }
    if (y < -0.45) y = -0.45 + (y + 0.45) * 0.35
    positions[i] = x
    positions[i + 1] = y
    positions[i + 2] = z
  }
  return { positions, indices, normals: vertexNormals(positions, indices) }
}

export function vertexNormals(positions: Float32Array, indices: ArrayLike<number>) {
  const normals = new Float32Array(positions.length)
  for (let f = 0; f < indices.length; f += 3) {
    const a = (indices[f] ?? 0) * 3,
      b = (indices[f + 1] ?? 0) * 3,
      c = (indices[f + 2] ?? 0) * 3
    const ux = (positions[b] ?? 0) - (positions[a] ?? 0),
      uy = (positions[b + 1] ?? 0) - (positions[a + 1] ?? 0),
      uz = (positions[b + 2] ?? 0) - (positions[a + 2] ?? 0)
    const vx = (positions[c] ?? 0) - (positions[a] ?? 0),
      vy = (positions[c + 1] ?? 0) - (positions[a + 1] ?? 0),
      vz = (positions[c + 2] ?? 0) - (positions[a + 2] ?? 0)
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx
    for (const v of [a, b, c]) {
      normals[v] = (normals[v] ?? 0) + nx
      normals[v + 1] = (normals[v + 1] ?? 0) + ny
      normals[v + 2] = (normals[v + 2] ?? 0) + nz
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i] ?? 0, normals[i + 1] ?? 0, normals[i + 2] ?? 0) || 1
    normals[i] = (normals[i] ?? 0) / length
    normals[i + 1] = (normals[i + 1] ?? 1) / length
    normals[i + 2] = (normals[i + 2] ?? 0) / length
  }
  return normals
}

export type PreparedBoulders = {
  positions: Float32Array
  normals: Int8Array
  /** Per vertex: tone, moss bias, height above the boulder's base (0..1), unused. */
  surface: Uint8Array
  indices: Uint32Array
  /** Vertices per boulder (every variant shares the icosphere topology). */
  stride: number
  count: number
}

/** Merge every boulder into one static, world-space mesh. */
export function prepareBoulders(boulders: readonly Boulder[], seed: number): PreparedBoulders {
  const shapes = Array.from({ length: BOULDER_VARIANTS }, (_, variant) =>
    boulderShape(variant, seed),
  )
  const stride = (shapes[0]?.positions.length ?? 0) / 3
  const triangles = shapes[0]?.indices.length ?? 0
  const positions = new Float32Array(boulders.length * stride * 3)
  const normals = new Int8Array(boulders.length * stride * 3)
  const surface = new Uint8Array(boulders.length * stride * 4)
  const indices = new Uint32Array(boulders.length * triangles)
  boulders.forEach((boulder, b) => {
    const shape = shapes[boulder.variant] ?? shapes[0]
    if (!shape) return
    // Basis: yaw about Y, then tilt Y onto `up`.
    const cy = Math.cos(boulder.yaw),
      sy = Math.sin(boulder.yaw)
    const [ux, uy, uz] = boulder.up
    // Rotation taking (0,1,0) to up (Rodrigues around axis (uz, 0, -ux)).
    const axisLength = Math.hypot(uz, ux)
    const angle = Math.acos(clamp(uy, -1, 1))
    const ax = axisLength > 1e-6 ? uz / axisLength : 1,
      az = axisLength > 1e-6 ? -ux / axisLength : 0
    const c = Math.cos(angle),
      s = Math.sin(angle)
    const tilt = (x: number, y: number, z: number): [number, number, number] => {
      // axis = (ax, 0, az)
      const dot = ax * x + az * z
      const crossX = -az * y,
        crossY = az * x - ax * z,
        crossZ = ax * y
      return [
        x * c + crossX * s + ax * dot * (1 - c),
        y * c + crossY * s,
        z * c + crossZ * s + az * dot * (1 - c),
      ]
    }
    const [sxSize, sySize, szSize] = boulder.size
    for (let v = 0; v < stride; v++) {
      const px = (shape.positions[v * 3] ?? 0) * sxSize,
        py = (shape.positions[v * 3 + 1] ?? 0) * sySize,
        pz = (shape.positions[v * 3 + 2] ?? 0) * szSize
      const rx = px * cy - pz * sy,
        rz = px * sy + pz * cy
      const [tx, ty, tz] = tilt(rx, py, rz)
      const at = (b * stride + v) * 3
      positions[at] = boulder.x + tx
      positions[at + 1] = boulder.y + ty
      positions[at + 2] = boulder.z + tz
      // Normals transform by the inverse scale.
      const nx = (shape.normals[v * 3] ?? 0) / sxSize,
        ny = (shape.normals[v * 3 + 1] ?? 0) / sySize,
        nz = (shape.normals[v * 3 + 2] ?? 0) / szSize
      const rnx = nx * cy - nz * sy,
        rnz = nx * sy + nz * cy
      const [mx, my, mz] = tilt(rnx, ny, rnz)
      const length = Math.hypot(mx, my, mz) || 1
      normals[at] = Math.round((mx / length) * 127)
      normals[at + 1] = Math.round((my / length) * 127)
      normals[at + 2] = Math.round((mz / length) * 127)
      const sAt = (b * stride + v) * 4
      surface[sAt] = Math.round(boulder.tone * 255)
      surface[sAt + 1] = Math.round(boulder.moss * 255)
      surface[sAt + 2] = Math.round(
        clamp(((shape.positions[v * 3 + 1] ?? 0) + 0.45) / 1.6, 0, 1) * 255,
      )
      surface[sAt + 3] = 0
    }
    for (let i = 0; i < triangles; i++)
      indices[b * triangles + i] = b * stride + (shape.indices[i] ?? 0)
  })
  return { positions, normals, surface, indices, stride, count: boulders.length }
}
