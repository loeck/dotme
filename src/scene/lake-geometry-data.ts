import { DataUtils } from 'three/webgpu'

import { required } from '../invariant'
import { prepareGeometryBounds } from './geometry-bounds'
import type { PreparedBounds } from './geometry-bounds'
import { LAKE_BOUNDS, WATER_LEVEL } from './lake-bed'
import type { LakeBed } from './lake-bed'

/** Transferable CPU data. BufferGeometry and textures are created only by the renderer. */
export type PreparedLakeGeometry = {
  positions: Float32Array
  normals: Float32Array
  uv: Float32Array
  indices: Uint16Array | Uint32Array
}
export type PreparedSubmergedSurface = {
  geometry: PreparedLakeGeometry
  bounds: PreparedBounds
  colors: Float32Array
  atlas: Uint16Array
  atlasWidth: number
  atlasHeight: number
}
export type PreparedWaterSurface = PreparedLakeGeometry & {
  boundingCenter: readonly [number, number, number]
  boundingRadius: number
}

function gridGeometry(segments: number): PreparedLakeGeometry {
  const n = segments + 1
  const count = n * n
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const uv = new Float32Array(count * 2)
  const indices =
    count > 65536 ? new Uint32Array(segments ** 2 * 6) : new Uint16Array(segments ** 2 * 6)
  let offset = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      uv[i * 2] = x / segments
      uv[i * 2 + 1] = 1 - y / segments
      if (x === segments || y === segments) continue
      const a = i,
        b = i + n,
        c = b + 1,
        d = a + 1
      indices.set([a, b, d, b, c, d], offset)
      offset += 6
    }
  }
  return { positions, normals, uv, indices }
}

/** Match indexed triangle area weighting before normalizing each vertex. */
function computeNormals(geometry: PreparedLakeGeometry) {
  const { positions: p, normals, indices } = geometry
  for (let i = 0; i < indices.length; i += 3) {
    const a = required(indices[i]) * 3,
      b = required(indices[i + 1]) * 3,
      c = required(indices[i + 2]) * 3
    const cbX = required(p[c]) - required(p[b]),
      cbY = required(p[c + 1]) - required(p[b + 1]),
      cbZ = required(p[c + 2]) - required(p[b + 2])
    const abX = required(p[a]) - required(p[b]),
      abY = required(p[a + 1]) - required(p[b + 1]),
      abZ = required(p[a + 2]) - required(p[b + 2])
    const nx = cbY * abZ - cbZ * abY,
      ny = cbZ * abX - cbX * abZ,
      nz = cbX * abY - cbY * abX
    for (const vertex of [a, b, c]) {
      normals[vertex] = required(normals[vertex]) + nx
      normals[vertex + 1] = required(normals[vertex + 1]) + ny
      normals[vertex + 2] = required(normals[vertex + 2]) + nz
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const x = required(normals[i]),
      y = required(normals[i + 1]),
      z = required(normals[i + 2])
    const length = Math.sqrt(x * x + y * y + z * z) || 1
    normals[i] = x / length
    normals[i + 1] = y / length
    normals[i + 2] = z / length
  }
}

export function prepareSubmergedSurface(bed: LakeBed): PreparedSubmergedSurface {
  const n = bed.resolution
  const atlasWidth = Math.sqrt(bed.shore.length)
  const atlasHeight = n + atlasWidth
  const atlas = new Uint16Array(atlasWidth * atlasHeight)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      atlas[y * atlasWidth + x] = DataUtils.toHalfFloat(required(bed.depth[y * n + x]))
  for (let i = 0; i < bed.shore.length; i++)
    atlas[n * atlasWidth + i] = DataUtils.toHalfFloat(required(bed.shore[i]))

  const geometry = gridGeometry(n - 1)
  const { positions } = geometry
  const colors = new Float32Array(n * n * 3)
  for (let i = 0; i < n * n; i++) {
    positions[i * 3] = LAKE_BOUNDS.minX + (((i % n) + 0.5) * LAKE_BOUNDS.size) / n
    positions[i * 3 + 1] = WATER_LEVEL - Math.max(0.04, required(bed.depth[i]))
    positions[i * 3 + 2] = LAKE_BOUNDS.minZ + ((Math.floor(i / n) + 0.5) * LAKE_BOUNDS.size) / n
    const worldX = required(positions[i * 3]),
      worldZ = required(positions[i * 3 + 2])
    const shade =
      0.76 +
      0.055 * Math.sin(worldX * 0.71 + Math.sin(worldZ * 0.43)) +
      0.035 * Math.sin(worldZ * 0.93 - worldX * 0.37)
    colors.set([shade, shade * 0.93, shade * 0.81], i * 3)
  }
  computeNormals(geometry)
  return {
    geometry,
    bounds: prepareGeometryBounds(positions),
    colors,
    atlas,
    atlasWidth,
    atlasHeight,
  }
}

export function prepareWaterSurface(mobile: boolean): PreparedWaterSurface {
  const segments = mobile ? 192 : 384
  const geometry = gridGeometry(segments)
  const n = segments + 1
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      // PlaneGeometry rounded its unit grid to Float32 before the nonlinear warp.
      const px = Math.fround(x * (1 / segments) - 0.5) * 2
      const t = 0.5 + Math.fround(-(y * (1 / segments) - 0.5))
      geometry.positions[i * 3] = Math.sign(px) * Math.abs(px) ** 2.6 * 500
      geometry.positions[i * 3 + 1] = -(24 - t ** 2.6 * 524)
      geometry.normals[i * 3 + 2] = 1
    }
  }
  return {
    ...geometry,
    boundingCenter: [0, 238, 0],
    boundingRadius: Math.sqrt(500 ** 2 + 262 ** 2),
  }
}

export type PreparedWaterMask = { resolution: number; water: Uint8Array; depth: Uint8Array }

/** The simulation wall follows terrain faces at the native shore-grid resolution. */
export function prepareWaterMask(bed: LakeBed): PreparedWaterMask {
  const resolution = Math.sqrt(bed.shore.length)
  if (resolution !== bed.resolution * 2)
    return {
      resolution: bed.resolution,
      water: bed.water,
      depth: Uint8Array.from(bed.depth, (value) => Math.round(Math.min(1, value / 7.5) * 255)),
    }
  const water = new Uint8Array(bed.shore.length)
  const depth = new Uint8Array(water.length)
  for (let i = 0; i < water.length; i++) {
    const x = Math.floor(((i % resolution) * bed.resolution) / resolution)
    const z = Math.floor((Math.floor(i / resolution) * bed.resolution) / resolution)
    water[i] = required(bed.shore[i]) > 0 ? 255 : 0
    depth[i] = Math.round(Math.min(1, required(bed.depth[z * bed.resolution + x]) / 7.5) * 255)
  }
  return { resolution, water, depth }
}
