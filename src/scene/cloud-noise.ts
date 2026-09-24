import { Data3DTexture, LinearFilter, RepeatWrapping, RGFormat } from 'three'

const smooth = (t: number) => t * t * (3 - 2 * t)
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const wrap = (x: number, period: number) => ((x % period) + period) % period
function hash(x: number, y: number, z: number, seed: number, period: number) {
  let h =
    seed ^
    Math.imul(wrap(x, period), 374761393) ^
    Math.imul(wrap(y, period), 668265263) ^
    Math.imul(wrap(z, period), 2147483647)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 0x1_0000_0000
}

/** Periodic in all three axes, including the lattice across texture boundaries. */
export function periodicNoise(x: number, y: number, z: number, seed: number, period: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z)
  const fx = smooth(x - ix),
    fy = smooth(y - iy),
    fz = smooth(z - iz)
  const layer = (dz: number) =>
    mix(
      mix(hash(ix, iy, iz + dz, seed, period), hash(ix + 1, iy, iz + dz, seed, period), fx),
      mix(hash(ix, iy + 1, iz + dz, seed, period), hash(ix + 1, iy + 1, iz + dz, seed, period), fx),
      fy,
    )
  return mix(layer(0), layer(1), fz)
}

function worley(x: number, y: number, z: number, seed: number, period: number) {
  let distance = 1
  const ix = Math.floor(x),
    iy = Math.floor(y),
    iz = Math.floor(z)
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const px = ix + dx,
          py = iy + dy,
          pz = iz + dz
        distance = Math.min(
          distance,
          Math.hypot(
            px + hash(px, py, pz, seed, period) - x,
            py + hash(px, py, pz, seed ^ 0x12345, period) - y,
            pz + hash(px, py, pz, seed ^ 0x98765, period) - z,
          ),
        )
      }
  return 1 - distance
}

export function createCloudNoiseData(seed: number, size = 32) {
  // Only shape and erosion are sampled; no unused coverage or alpha channels.
  const data = new Uint8Array(size ** 3 * 2)
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        // Sample texel centers so repeat+linear interpolates the periodic border.
        const px = (x + 0.5) / size,
          py = (y + 0.5) / size,
          pz = (z + 0.5) / size
        const value = (frequency: number, salt: number) =>
          periodicNoise(px * frequency, py * frequency, pz * frequency, seed ^ salt, frequency)
        const i = ((z * size + y) * size + x) * 2
        data[i] = Math.round(255 * (value(4, 0) * 0.65 + value(8, 17) * 0.25 + value(16, 39) * 0.1))
        data[i + 1] = Math.round(255 * worley(px * 8, py * 8, pz * 8, seed ^ 991, 8))
      }
  return data
}

export function createCloudNoise(seed: number, size = 32, prepared?: Uint8Array) {
  const texture = new Data3DTexture(prepared ?? createCloudNoiseData(seed, size), size, size, size)
  texture.format = RGFormat
  texture.minFilter = texture.magFilter = LinearFilter
  texture.wrapS = texture.wrapT = texture.wrapR = RepeatWrapping
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}
