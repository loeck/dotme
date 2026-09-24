export type FishMotionPointer = Readonly<{ x: number; z: number; strength?: number }>
export type FishMotionHome = Readonly<{ x: number; z: number; radius: number }>
export type FishBehavior = Readonly<{
  cruiseSpeed?: number
  burstSpeed?: number
  /** Maximum turn speed, in radians per second. */
  agility?: number
  /** Maximum change in forward speed, in world units per second squared. */
  acceleration?: number
}>

export type FishMotionState = {
  x: number
  z: number
  /** Rotation about world Y; local +Z is the nose. Unwrapped for continuity. */
  heading: number
  speed: number
  effort: number
  roll: number
  tailPhase: number
  alert: number
  turnRate: number
  elapsed: number
  readonly behavior: Required<FishBehavior>
  readonly phases: readonly [number, number, number]
  readonly tempo: number
  /** Smoothed avoidance memory, retained while a pointer leaves the scene. */
  fleeX: number
  fleeZ: number
  threatLatched: boolean
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const smooth = (min: number, max: number, value: number) => {
  const t = clamp((value - min) / (max - min), 0, 1)
  return t * t * (3 - 2 * t)
}
const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? clamp(value!, min, max) : fallback

/** Start at the supplied safe pose. A short acceleration from rest avoids a spawn jump. */
export function createFishMotion(
  x: number,
  z: number,
  heading: number,
  seed: number,
  behavior: FishBehavior = {},
): FishMotionState {
  let randomState = (seed ^ 0x9e3779b9) >>> 0
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
    return randomState / 0x1_0000_0000
  }
  const cruiseSpeed = bounded(behavior.cruiseSpeed, 0.2, 0.04, 0.6)
  return {
    x,
    z,
    heading,
    speed: 0,
    effort: 0.15,
    roll: 0,
    tailPhase: random() * Math.PI * 2,
    alert: 0,
    turnRate: 0,
    elapsed: 0,
    behavior: {
      cruiseSpeed,
      burstSpeed: bounded(behavior.burstSpeed, Math.max(cruiseSpeed, 0.58), cruiseSpeed, 1.2),
      agility: bounded(behavior.agility, 1.9, 0.5, 4),
      acceleration: bounded(behavior.acceleration, 0.55, 0.15, 3),
    },
    phases: [random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2],
    tempo: 0.68 + random() * 0.35,
    fleeX: 0,
    fleeZ: 0,
    threatLatched: false,
  }
}

/** Distance to the checked circular boundary along a unit swimming direction. */
function clearRun(x: number, z: number, dx: number, dz: number, radius: number) {
  const along = x * dx + z * dz
  return Math.max(
    0,
    -along + Math.sqrt(Math.max(0, along * along + radius * radius - x * x - z * z)),
  )
}

/** Stateful steering; never replaces the swimming path or teleports to an escape orbit.
 * Call once per frame, with a neighbor's previous-frame position when schooling.
 * The caller retains its existing static pose when reduced motion is requested. */
export function advanceFishMotion(
  state: FishMotionState,
  home: FishMotionHome,
  dt: number,
  pointer: FishMotionPointer | null = null,
  neighbor?: Readonly<{ x: number; z: number }>,
) {
  if (!Number.isFinite(dt) || dt <= 0 || home.radius <= 0) return state
  const duration = Math.min(dt, 0.1)
  const steps = Math.ceil(duration * 120)
  const h = duration / steps
  const { cruiseSpeed, burstSpeed, agility, acceleration } = state.behavior
  const radius = home.radius
  for (let step = 0; step < steps; step++) {
    state.elapsed += h
    const time = state.elapsed
    const localX = state.x - home.x,
      localZ = state.z - home.z
    const distance = Math.hypot(localX, localZ)
    const nx = localX / Math.max(distance, 0.0001),
      nz = localZ / Math.max(distance, 0.0001)
    const headingX = Math.sin(state.heading),
      headingZ = Math.cos(state.heading)

    let threat = 0,
      fleeX = 0,
      fleeZ = 0
    if (pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.z)) {
      const awayX = state.x - pointer.x,
        awayZ = state.z - pointer.z
      const awayDistance = Math.hypot(awayX, awayZ)
      const strength = bounded(pointer.strength, 1, 0, 1)
      state.threatLatched = state.threatLatched
        ? awayDistance < 3.4 && strength > 0.015
        : awayDistance < 2.8 && strength > 0.05
      if (state.threatLatched) {
        threat = (1 - smooth(0.25, 3.4, awayDistance)) * strength
        // Soft normalization has no singular direction at exact cursor contact.
        // A little forward escape keeps a stationary central pointer from trapping a fish.
        const softDistance = Math.sqrt(awayDistance * awayDistance + 0.09)
        const forward = 0.3 * Math.exp((-awayDistance * awayDistance) / 0.09)
        fleeX = awayX / softDistance + headingX * forward
        fleeZ = awayZ / softDistance + headingZ * forward
      }
    } else state.threatLatched = false
    state.alert += (threat - state.alert) * (1 - Math.exp(-h * (threat > state.alert ? 5 : 0.9)))
    const fleeFollow = 1 - Math.exp(-h * 5)
    state.fleeX += (fleeX - state.fleeX) * fleeFollow
    state.fleeZ += (fleeZ - state.fleeZ) * fleeFollow

    // Independent, incommensurate heading meanders and short propulsion strokes
    // produce exploratory arcs and glides rather than a time-parametrized oval.
    const wander =
      state.phases[0] +
      Math.sin(time * 0.31 * state.tempo + state.phases[1]) * 1.1 +
      Math.sin(time * 0.73 * state.tempo + state.phases[2]) * 0.42
    let desiredX = Math.sin(wander) + state.fleeX * state.alert * 2.3
    let desiredZ = Math.cos(wander) + state.fleeZ * state.alert * 2.3
    if (neighbor) {
      const dx = state.x - neighbor.x,
        dz = state.z - neighbor.z
      const separation = Math.hypot(dx, dz)
      const push = ((1 - smooth(0.12, 0.7, separation)) * 0.65) / Math.max(0.12, separation)
      desiredX += dx * push
      desiredZ += dz * push
    }

    // Turn well before reaching the safe boundary. At the outer ring, remove
    // outward intent even during a sustained flee; a pointer cannot push fish onto land.
    const wall = smooth(radius * 0.42, radius * 0.78, distance)
    const outward = Math.max(0, desiredX * nx + desiredZ * nz)
    desiredX -= nx * (outward + 1.1) * wall
    desiredZ -= nz * (outward + 1.1) * wall
    const desiredHeading = Math.atan2(desiredX, desiredZ)
    const error = Math.atan2(
      Math.sin(desiredHeading - state.heading),
      Math.cos(desiredHeading - state.heading),
    )
    const targetTurn = clamp(error * 3.1, -agility, agility)
    const turnChange = (targetTurn - state.turnRate) * (1 - Math.exp(-h * 7))
    state.turnRate += clamp(turnChange, -agility * 4 * h, agility * 4 * h)
    state.heading += state.turnRate * h

    const stroke = Math.max(0, Math.sin(time * state.tempo + state.phases[2])) ** 3
    const passiveSpeed = cruiseSpeed * (0.58 + stroke * 0.82)
    let targetSpeed = passiveSpeed + (burstSpeed - passiveSpeed) * state.alert
    targetSpeed *= 1 - smooth(0.6, 2.8, Math.abs(error)) * 0.5
    const dx = Math.sin(state.heading),
      dz = Math.cos(state.heading)
    const lookHeading = state.heading + state.turnRate * 0.35
    const run = Math.min(
      clearRun(localX, localZ, dx, dz, radius),
      clearRun(localX, localZ, Math.sin(lookHeading), Math.cos(lookHeading), radius),
    )
    // Start braking before the turn's swept path reaches the edge.
    targetSpeed = Math.min(targetSpeed, Math.sqrt(2 * acceleration * Math.max(0, run - 0.12)))
    const previousSpeed = state.speed
    state.speed += clamp(targetSpeed - state.speed, -acceleration * h, acceleration * h)
    // Exact segment/circle intersection is a final numerical guard, never a
    // clamp of the position or a respawn. Ordinary trajectories turn before it.
    const travel = Math.min(state.speed * h, clearRun(localX, localZ, dx, dz, radius) * 0.999999)
    state.x += dx * travel
    state.z += dz * travel
    state.speed = travel / h
    const exertion = clamp((state.speed - previousSpeed) / (h * acceleration), 0, 1)
    const effort = clamp(0.1 + stroke * 0.4 + state.alert * 0.48 + exertion * 0.25, 0.08, 1)
    state.effort += (effort - state.effort) * (1 - Math.exp(-h * 5))
    const targetRoll = clamp(-state.turnRate * state.speed * 0.4, -0.22, 0.22)
    state.roll += (targetRoll - state.roll) * (1 - Math.exp(-h * 6))
    state.tailPhase += (2.8 + state.effort * 5.2 + state.speed * 4) * h
  }
  return state
}
