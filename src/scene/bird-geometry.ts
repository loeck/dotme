import type { BirdShape } from './bird-species'

/**
 * A low-poly bird in flight, built from a species' proportions: a spindle body of four rings
 * (head, chest, back, rump) with a bill, a flat tail (forked, square or rounded) and two wings
 * of two panels each, the arm and the hand, hinged at the shoulder and the wrist. Every species
 * has the same vertex count and layout, so one buffer is rewritten when the species changes and
 * the shader never changes. Non-indexed: each triangle carries its own flat normal and paint.
 *
 * Per vertex:
 * - `position`, `normal`: rest pose, wings level; the bird faces +Z with +Y up.
 * - `aWing` (arm reach, hand reach, share along the hand, wing mask): the vertex shader turns
 *   the arm about the shoulder by the reach along it and the hand about the wrist.
 * - `aPaint` (head, belly, tail, bill): plumage region weights.
 */
const BIRD_TRIANGLES = 49
export const BIRD_VERTICES = BIRD_TRIANGLES * 3

export type BirdBuffers = {
  position: Float32Array
  normal: Float32Array
  wing: Float32Array
  paint: Float32Array
}

export const createBirdBuffers = (): BirdBuffers => ({
  position: new Float32Array(BIRD_VERTICES * 3),
  normal: new Float32Array(BIRD_VERTICES * 3),
  wing: new Float32Array(BIRD_VERTICES * 4),
  paint: new Float32Array(BIRD_VERTICES * 4),
})

type Vertex = Readonly<{
  x: number
  y: number
  z: number
  /** Arm and hand reach from the shoulder, share along the hand, wing mask. */
  wing?: readonly [number, number, number, number]
  head?: number
  bill?: number
  tail?: number
}>

/** A ring of four around the body axis at `z`: top, right, bottom, left. */
const ring = (
  z: number,
  y: number,
  width: number,
  top: number,
  bottom: number,
  paint: Partial<Vertex> = {},
): Vertex[] => [
  { x: 0, y: y + top, z, ...paint },
  { x: width, y, z, ...paint },
  { x: 0, y: y - bottom, z, ...paint },
  { x: -width, y, z, ...paint },
]

/** Writes `shape`'s bird into `out` (rest pose); returns `out`. */
export function writeBird(shape: BirdShape, out: BirdBuffers = createBirdBuffers()): BirdBuffers {
  const L = shape.length,
    g = shape.girth
  let cursor = 0
  const a = { x: 0, y: 0, z: 0 },
    b = { x: 0, y: 0, z: 0 },
    n = { x: 0, y: 0, z: 0 }

  /**
   * One triangle, wound so that its normal points along `outX/Y/Z` (away from the body's axis,
   * or up for the flat wings and tail): the front face of a wing is its upper side.
   */
  const tri = (
    p: Vertex,
    q: Vertex,
    r: Vertex,
    outX: number,
    outY: number,
    outZ: number,
    belly = -1,
  ) => {
    a.x = q.x - p.x
    a.y = q.y - p.y
    a.z = q.z - p.z
    b.x = r.x - p.x
    b.y = r.y - p.y
    b.z = r.z - p.z
    n.x = a.y * b.z - a.z * b.y
    n.y = a.z * b.x - a.x * b.z
    n.z = a.x * b.y - a.y * b.x
    let first = q,
      second = r
    if (n.x * outX + n.y * outY + n.z * outZ < 0) {
      first = r
      second = q
      n.x = -n.x
      n.y = -n.y
      n.z = -n.z
    }
    const length = Math.hypot(n.x, n.y, n.z) || 1
    n.x /= length
    n.y /= length
    n.z /= length
    // The underside of the body takes the belly's colour; flanks blend.
    const under = belly >= 0 ? belly : Math.min(1, Math.max(0, (0.3 - n.y) / 0.75))
    for (const v of [p, first, second]) {
      const i = cursor++
      out.position.set([v.x, v.y, v.z], i * 3)
      out.normal.set([n.x, n.y, n.z], i * 3)
      out.wing.set(v.wing ?? [0, 0, 0, 0], i * 4)
      out.paint.set([v.head ?? 0, v.wing ? 0 : under, v.tail ?? 0, v.bill ?? 0], i * 4)
    }
  }

  /** Joins two rings with eight triangles facing away from the axis. */
  const band = (front: Vertex[], back: Vertex[], centreY: number) => {
    for (let k = 0; k < 4; k++) {
      const f0 = front[k],
        f1 = front[(k + 1) % 4],
        b0 = back[k],
        b1 = back[(k + 1) % 4]
      if (!f0 || !f1 || !b0 || !b1) continue
      const mx = (f0.x + f1.x + b0.x + b1.x) / 4,
        my = (f0.y + f1.y + b0.y + b1.y) / 4 - centreY
      tri(f0, b0, b1, mx, my, 0)
      tri(f0, b1, f1, mx, my, 0)
    }
  }

  // Body: the head sits a little up and ahead of the chest, on a duck's long neck far ahead.
  const headZ = L * (0.25 + shape.neck),
    headY = g * 0.28,
    headR = g * 0.72
  const billBase = ring(
    headZ + headR * 0.75,
    headY - headR * 0.1,
    headR * 0.34,
    headR * 0.3,
    headR * 0.3,
    {
      head: 1,
      bill: 1,
    },
  )
  const billTip: Vertex = {
    x: 0,
    y: headY - headR * 0.15,
    z: headZ + headR * 0.75 + shape.bill,
    head: 1,
    bill: 1,
  }
  const head = ring(headZ, headY, headR, headR, headR * 0.9, { head: 1 })
  const chest = ring(L * 0.07, 0, g * 0.95, g * 0.9, g * 1.05)
  const back = ring(-L * 0.1, 0, g, g * 0.85, g)
  const rumpZ = -L * 0.27
  const rump = ring(rumpZ, g * 0.05, g * 0.45, g * 0.35, g * 0.35, { tail: 0.5 })
  for (let k = 0; k < 4; k++) {
    const v0 = billBase[k],
      v1 = billBase[(k + 1) % 4]
    if (v0 && v1) tri(billTip, v0, v1, (v0.x + v1.x) / 2, (v0.y + v1.y) / 2 - billTip.y, 1)
  }
  band(billBase, head, headY)
  band(head, chest, headY * 0.5)
  band(chest, back, 0)
  band(back, rump, 0)
  const [rumpTop, rumpRight, rumpBottom, rumpLeft] = rump
  if (rumpTop && rumpRight && rumpBottom && rumpLeft) {
    tri(rumpTop, rumpRight, rumpBottom, 0, 0, -1)
    tri(rumpTop, rumpBottom, rumpLeft, 0, 0, -1)
  }

  // Tail: a flat fan behind the rump, forked or rounded at its tip.
  const tailZ = rumpZ - shape.tail
  const tailBaseL: Vertex = { x: -g * 0.42, y: g * 0.05, z: rumpZ + g * 0.2, tail: 1 },
    tailBaseR: Vertex = { x: g * 0.42, y: g * 0.05, z: rumpZ + g * 0.2, tail: 1 },
    tailTipL: Vertex = { x: -shape.tailWidth, y: g * 0.05, z: tailZ, tail: 1 },
    tailTipR: Vertex = { x: shape.tailWidth, y: g * 0.05, z: tailZ, tail: 1 },
    notch: Vertex = { x: 0, y: g * 0.05, z: tailZ + shape.fork, tail: 1 }
  tri(tailBaseL, tailTipL, notch, 0, 1, 0, 0)
  tri(tailBaseL, notch, tailBaseR, 0, 1, 0, 0)
  tri(tailBaseR, notch, tailTipR, 0, 1, 0, 0)

  // Wings: the arm from the shoulder to the wrist, then the hand to the tip.
  const shoulder = g * 0.85
  const half = shape.span / 2 - shoulder
  const arm = half * shape.wrist,
    hand = half - arm
  const lead = shape.chord * 0.38
  const wristLead = lead - shape.sweep * 0.25
  const wristTrail = wristLead - shape.chord * shape.hand
  const tipZ = lead - shape.sweep - shape.chord * shape.hand * 0.22
  // A broad, fingered hand (crow) keeps its area to near the tip; a narrow one (gull) tapers.
  const round = Math.min(1, Math.max(0, (shape.hand - 0.6) / 0.35))
  const midTrail = wristTrail + (tipZ - wristTrail) * (0.62 - 0.4 * round)
  for (const side of [-1, 1]) {
    const wingVertex = (reach: number, y: number, z: number): Vertex => {
      const inner = Math.min(reach, arm),
        outer = Math.max(0, reach - arm)
      return { x: side * (shoulder + reach), y, z, wing: [inner, outer, outer / hand, 1] }
    }
    // A cambered wing: the leading edge stands a tenth of the chord above the trailing edge,
    // so a wing seen edge-on is still a sliver rather than a hairline.
    const sl = wingVertex(0, shape.chord * 0.1, lead),
      st = wingVertex(0, 0, lead - shape.chord),
      wl = wingVertex(arm, shape.chord * shape.hand * 0.1, wristLead),
      wt = wingVertex(arm, 0, wristTrail),
      tip = wingVertex(half, 0, tipZ),
      mt = wingVertex(arm + hand * (0.72 + 0.1 * round), 0, midTrail)
    tri(sl, wl, wt, 0, 1, 0)
    tri(sl, wt, st, 0, 1, 0)
    tri(wl, tip, mt, 0, 1, 0)
    tri(wl, mt, wt, 0, 1, 0)
  }
  if (cursor !== BIRD_VERTICES) throw new Error(`Bird geometry wrote ${cursor} vertices`)
  return out
}

/**
 * Where the vertex shader (`bird-material.ts`) puts rest vertex `i` of `buffers` for a pose:
 * the arm turned about the shoulder, the hand about the wrist and tucked by `fold`. The same
 * arithmetic on the CPU, so tests can bound every pose.
 */
export function hingedVertex(
  buffers: BirdBuffers,
  i: number,
  pose: Readonly<{ shoulder: number; wrist: number; fold: number }>,
  out: { x: number; y: number; z: number },
) {
  const x = buffers.position[i * 3] ?? 0,
    y = buffers.position[i * 3 + 1] ?? 0,
    z = buffers.position[i * 3 + 2] ?? 0
  const arm = buffers.wing[i * 4] ?? 0,
    reach = buffers.wing[i * 4 + 1] ?? 0
  const hand = reach * (1 - pose.fold * 0.45)
  const wrist = pose.shoulder + pose.wrist
  const side = Math.sign(x)
  out.x = x + side * (arm * (Math.cos(pose.shoulder) - 1) + hand * Math.cos(wrist) - reach)
  out.y = y + arm * Math.sin(pose.shoulder) + hand * Math.sin(wrist)
  out.z = z - reach * pose.fold * 0.6
  return out
}
