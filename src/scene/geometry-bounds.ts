import { required } from '../invariant'

export type PreparedBounds = {
  min: readonly [number, number, number]
  max: readonly [number, number, number]
  center: readonly [number, number, number]
  radius: number
}

/** Compute the same box-centered sphere used by BufferGeometry, before transferring it. */
export function prepareGeometryBounds(positions: Float32Array | Float64Array): PreparedBounds {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = required(positions[i]),
      y = required(positions[i + 1]),
      z = required(positions[i + 2])
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }
  const center: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
  let radiusSquared = 0
  for (let i = 0; i < positions.length; i += 3) {
    const x = required(positions[i]) - center[0],
      y = required(positions[i + 1]) - center[1],
      z = required(positions[i + 2]) - center[2]
    radiusSquared = Math.max(radiusSquared, x * x + y * y + z * z)
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center,
    radius: Math.sqrt(radiusSquared),
  }
}
