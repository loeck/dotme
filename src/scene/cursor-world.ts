export const SKY_HOLE_LIFETIME = 3
export const SKY_HOLE_COUNT = 8
export const SKY_HOLE_RADIUS = 12
export const SKY_HOLE_SPACING = 0.05
/** Voxels less than this in front of the curtain plane don't veto the block. */
export const WATERFALL_OCCLUSION_TOLERANCE = 0.5

type Point = Readonly<{ x: number; y: number; z: number }>
export type WaterfallShape = Readonly<{
  x: number
  z: number
  top: number
  width: number
  direction: readonly [number, number]
}>

export type WaterfallHit = Readonly<{
  across: number
  height: number
  distance: number
  strength: number
}>

/** Ray against the fall's curtain plane, in the waterfall group's local frame. */
export function sampleWaterfallHit(
  origin: Point,
  direction: Point,
  fall: WaterfallShape,
  waterLevel: number,
): WaterfallHit | null {
  const length = Math.hypot(fall.direction[0], fall.direction[1])
  if (!(length > 0)) return null
  const nx = fall.direction[0] / length
  const nz = fall.direction[1] / length
  const denom = direction.x * nx + direction.z * nz
  if (Math.abs(denom) < 1e-9) return null
  const distance = ((fall.x - origin.x) * nx + (fall.z - origin.z) * nz) / denom
  if (!(distance >= 0)) return null
  const px = origin.x + direction.x * distance
  const py = origin.y + direction.y * distance
  const pz = origin.z + direction.z * distance
  const across = (px - fall.x) * nz - (pz - fall.z) * nx
  const height = py - waterLevel
  const total = fall.top - waterLevel
  const reach = fall.width / 2 + 0.15
  if (Math.abs(across) > reach || height < 0 || height > total) return null
  const edge = Math.min(reach - Math.abs(across), height, total - height)
  const t = Math.max(0, Math.min(1, edge / 0.15))
  return { across, height, distance, strength: t * t * (3 - 2 * t) }
}

export type TrailHole = Readonly<{
  x: number
  y: number
  z: number
  born: number
  strength: number
}>

/**
 * The canvas fills the viewport, so any non-interactive topmost element still
 * leaves the world beneath the cursor. Only controls and dialogs capture it.
 */
export function seesWorld(target: unknown): boolean {
  if (typeof target !== 'object' || target === null || !('closest' in target)) return false
  const closest = target.closest
  if (typeof closest !== 'function') return false
  return closest.call(target, 'dialog, a[href], button, [role="button"]') === null
}

/**
 * Newest-first ring of cursor ray directions with exponential decay. Clouds
 * are optically thick, so each hole punches the full marched column along its
 * ray instead of a sphere: small tunnels read clearly where spheres vanish.
 */
export class CursorTrail {
  private readonly slots: { x: number; y: number; z: number; born: number }[] = []
  private readonly capacity: number
  private readonly spacing: number

  constructor(capacity: number = SKY_HOLE_COUNT, spacing: number = SKY_HOLE_SPACING) {
    this.capacity = capacity
    this.spacing = spacing
  }

  /** Stacked pushes refresh the newest hole instead of opening a twin. */
  push(x: number, y: number, z: number, time: number): boolean {
    const newest = this.slots[0]
    if (newest && Math.hypot(x - newest.x, y - newest.y, z - newest.z) < this.spacing) {
      newest.born = time
      return false
    }
    this.slots.unshift({ x, y, z, born: time })
    this.slots.length = Math.min(this.slots.length, this.capacity)
    return true
  }

  snapshot(time: number): TrailHole[] {
    return this.slots.map((slot) => ({
      ...slot,
      strength: Math.max(0, Math.min(1, Math.exp(-(time - slot.born) / SKY_HOLE_LIFETIME))),
    }))
  }
}
