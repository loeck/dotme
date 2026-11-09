/**
 * Integer lattice hash in [0, 1) for seeded world generation: lowbias32-style mixing of a
 * seed, two integer coordinates (truncated as by `| 0`) and a stream that decorrelates uses.
 * Bit-identical to the copies it replaced in the lake, forest, mesh and grass generators.
 */
export function latticeHash(seed: number, x: number, z: number, stream = 0) {
  let value = (seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(z, 0x85ebca77) ^ stream) >>> 0
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d)
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b)
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000
}
