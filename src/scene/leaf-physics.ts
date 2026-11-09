/**
 * A shed leaf as a light rigid plate, integrated on the CPU. Rapier would cost a body, a
 * collider and per-substep force callbacks for each of up to 160 leaves whose only contact is
 * landing; a leaf only needs drag, its turning moments and a ground height, which the scene
 * casts against the same Rapier statics (`ScenePicker.restingPoint`).
 *
 * The model is a flat plate: air resists motion across the blade far more than along it, so a
 * tilted leaf glides; the flow turns the blade broadside to itself (the centre of pressure sits
 * ahead of the centroid), so a gliding leaf pitches up, stalls and swings back; shed vortices
 * rock it about its midrib; and a few leaves are driven past the broadside moment into
 * autorotation and tumble end over end. Drag and spin damping are integrated implicitly, so a
 * frame step of 0.1 s stays stable however strong the gust.
 */
export type LeafBody = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  /** Orientation; the blade's normal is its local +Y, its midrib +Z. */
  qx: number
  qy: number
  qz: number
  qw: number
  /** World-frame angular velocity, rad/s. */
  wx: number
  wy: number
  wz: number
  /** Drag across the blade, per metre: gravity over the square of the flat terminal speed. */
  normalDrag: number
  /** Vortex-shedding roll about the midrib, rad/s² per (m/s)² of airflow. */
  flutter: number
  flutterRate: number
  phase: number
  /** Autorotation drive about the lateral axis, rad/s² per (m/s)²; 0 for a flutterer. */
  tumble: number
}

export const LEAF_AERO = {
  gravity: 9.81,
  /** Drag along the blade, per second: a leaf edge-on slices through the air. */
  tangentDrag: 2.6,
  /** Angular acceleration per (m/s)² turning the blade broadside to the airflow. */
  broadside: 150,
  /** Linear and quadratic spin damping, per second and per radian. */
  spinDamping: 4.5,
  spinDrag: 1.2,
  /** Sideways lift of a spinning blade (Magnus), per radian. */
  magnus: 0.05,
  /** Airflow cap in the moments, and a spin cap: a gale must not spin a leaf into strobing. */
  maxFlow: 3,
  maxSpin: 16,
  /** A floating leaf: share of the surface slope's pull, and how fast it takes the drift. */
  slopePull: 0.6,
  floatResponse: 1.8,
} as const

export function createLeafBody(): LeafBody {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    wx: 0,
    wy: 0,
    wz: 0,
    normalDrag: LEAF_AERO.gravity,
    flutter: 0,
    flutterRate: 0,
    phase: 0,
    tumble: 0,
  }
}

/** The blade's normal, the world image of local +Y; `y` alone is its cosine of tilt. */
export function leafNormalY(leaf: LeafBody) {
  return 1 - 2 * (leaf.qx * leaf.qx + leaf.qz * leaf.qz)
}

/** Turns the leaf by `angle` about the unit world axis (ax, ay, az). */
export function rotateLeaf(leaf: LeafBody, ax: number, ay: number, az: number, angle: number) {
  const half = angle * 0.5
  const s = Math.sin(half),
    c = Math.cos(half)
  const rx = ax * s,
    ry = ay * s,
    rz = az * s
  const { qx, qy, qz, qw } = leaf
  leaf.qx = c * qx + rx * qw + (ry * qz - rz * qy)
  leaf.qy = c * qy + ry * qw + (rz * qx - rx * qz)
  leaf.qz = c * qz + rz * qw + (rx * qy - ry * qx)
  leaf.qw = c * qw - (rx * qx + ry * qy + rz * qz)
  normalise(leaf)
}

function normalise(leaf: LeafBody) {
  const length = Math.hypot(leaf.qx, leaf.qy, leaf.qz, leaf.qw)
  if (!(length > 1e-9)) {
    leaf.qx = leaf.qy = leaf.qz = 0
    leaf.qw = 1
    return
  }
  leaf.qx /= length
  leaf.qy /= length
  leaf.qz /= length
  leaf.qw /= length
}

/**
 * Advances a leaf in the air by `h` seconds through air moving at (airX, airY, airZ); `time`
 * drives the shed vortices. Keep `h` at or under ~1/30 s for the moments to stay smooth.
 */
export function stepLeafInAir(
  leaf: LeafBody,
  airX: number,
  airY: number,
  airZ: number,
  time: number,
  h: number,
) {
  const { qx, qy, qz, qw } = leaf
  // Body axes in the world: normal n (+Y), lateral r (+X), midrib f (+Z).
  const nx = 2 * (qx * qy - qw * qz),
    ny = 1 - 2 * (qx * qx + qz * qz),
    nz = 2 * (qy * qz + qw * qx)
  const rx = 1 - 2 * (qy * qy + qz * qz),
    ry = 2 * (qx * qy + qw * qz),
    rz = 2 * (qx * qz - qw * qy)
  const fx = 2 * (qx * qz + qw * qy),
    fy = 2 * (qy * qz - qw * qx),
    fz = 1 - 2 * (qx * qx + qy * qy)

  leaf.vy -= LEAF_AERO.gravity * h
  const ux = leaf.vx - airX,
    uy = leaf.vy - airY,
    uz = leaf.vz - airZ
  const across = ux * nx + uy * ny + uz * nz
  const tx = ux - across * nx,
    ty = uy - across * ny,
    tz = uz - across * nz
  const keptAcross = across / (1 + h * leaf.normalDrag * Math.abs(across))
  const keptAlong = 1 / (1 + h * LEAF_AERO.tangentDrag)
  const { wx, wy, wz } = leaf
  // A spinning blade throws the air to one side and drifts the other way.
  const magnus = LEAF_AERO.magnus * h
  leaf.vx = airX + keptAcross * nx + tx * keptAlong + magnus * (wy * uz - wz * uy)
  leaf.vy = airY + keptAcross * ny + ty * keptAlong + magnus * (wz * ux - wx * uz)
  leaf.vz = airZ + keptAcross * nz + tz * keptAlong + magnus * (wx * uy - wy * ux)

  let tauX = 0,
    tauY = 0,
    tauZ = 0
  const speed = Math.hypot(ux, uy, uz)
  if (speed > 1e-4) {
    const flow = Math.min(speed, LEAF_AERO.maxFlow)
    const pressure = flow * flow
    // Turn the blade's face toward the relative wind: a × û with a = ±n facing the flow.
    const side = across < 0 ? -1 : 1
    const ax = nx * side,
      ay = ny * side,
      az = nz * side
    const turn = (LEAF_AERO.broadside * pressure) / speed
    tauX = turn * (ay * uz - az * uy)
    tauY = turn * (az * ux - ax * uz)
    tauZ = turn * (ax * uy - ay * ux)
    const rock = leaf.flutter * pressure * Math.sin(leaf.phase + leaf.flutterRate * time)
    const spin = leaf.tumble * pressure
    tauX += rock * fx + spin * rx
    tauY += rock * fy + spin * ry
    tauZ += rock * fz + spin * rz
  }
  const damping = 1 + h * (LEAF_AERO.spinDamping + LEAF_AERO.spinDrag * Math.hypot(wx, wy, wz))
  const nextX = (wx + h * tauX) / damping,
    nextY = (wy + h * tauY) / damping,
    nextZ = (wz + h * tauZ) / damping
  const cap = Math.min(1, LEAF_AERO.maxSpin / Math.max(1e-9, Math.hypot(nextX, nextY, nextZ)))
  leaf.wx = nextX * cap
  leaf.wy = nextY * cap
  leaf.wz = nextZ * cap

  leaf.x += leaf.vx * h
  leaf.y += leaf.vy * h
  leaf.z += leaf.vz * h
  integrateSpin(leaf, h)
}

/** q += ½ h (ω, 0) ⊗ q, renormalised. */
function integrateSpin(leaf: LeafBody, h: number) {
  const { qx, qy, qz, qw, wx, wy, wz } = leaf
  const k = 0.5 * h
  leaf.qx = qx + k * (qw * wx + (wy * qz - wz * qy))
  leaf.qy = qy + k * (qw * wy + (wz * qx - wx * qz))
  leaf.qz = qz + k * (qw * wz + (wx * qy - wy * qx))
  leaf.qw = qw - k * (wx * qx + wy * qy + wz * qz)
  normalise(leaf)
}

/**
 * Tilts the blade a share `amount` (0–1) of the way to lie on a surface with unit normal
 * (sx, sy, sz), on whichever face is nearer: a leaf settles as it lands, upside down or not.
 */
export function settleLeaf(leaf: LeafBody, sx: number, sy: number, sz: number, amount: number) {
  const { qx, qy, qz, qw } = leaf
  let nx = 2 * (qx * qy - qw * qz),
    ny = 1 - 2 * (qx * qx + qz * qz),
    nz = 2 * (qy * qz + qw * qx)
  if (nx * sx + ny * sy + nz * sz < 0) {
    nx = -nx
    ny = -ny
    nz = -nz
  }
  const ax = ny * sz - nz * sy,
    ay = nz * sx - nx * sz,
    az = nx * sy - ny * sx
  const sine = Math.hypot(ax, ay, az)
  if (sine < 1e-6) return
  const angle = Math.atan2(sine, nx * sx + ny * sy + nz * sz)
  rotateLeaf(leaf, ax / sine, ay / sine, az / sine, angle * amount)
}

/**
 * A leaf afloat for `h` seconds: it rides the surface height, lies on its slope, slides down
 * the slope (so passing ripples push it) and takes the drift (wind on the blade, the pointer's
 * gusts) at a rate; its spin about the vertical dies away.
 */
export function floatLeaf(
  leaf: LeafBody,
  surface: number,
  slopeX: number,
  slopeZ: number,
  driftX: number,
  driftZ: number,
  h: number,
) {
  const pull = LEAF_AERO.gravity * LEAF_AERO.slopePull * h
  leaf.vx -= slopeX * pull
  leaf.vz -= slopeZ * pull
  const take = 1 - Math.exp(-h * LEAF_AERO.floatResponse)
  leaf.vx += (driftX - leaf.vx) * take
  leaf.vz += (driftZ - leaf.vz) * take
  leaf.vy = 0
  leaf.x += leaf.vx * h
  leaf.z += leaf.vz * h
  leaf.y = surface
  leaf.wx = leaf.wz = 0
  leaf.wy *= Math.exp(-h * 0.9)
  if (leaf.wy !== 0) rotateLeaf(leaf, 0, 1, 0, leaf.wy * h)
  const length = Math.hypot(slopeX, 1, slopeZ)
  settleLeaf(leaf, -slopeX / length, 1 / length, -slopeZ / length, 1 - Math.exp(-h * 6))
}
