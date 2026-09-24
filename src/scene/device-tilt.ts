const RANGE = (25 * Math.PI) / 180
const DEAD_ZONE = (2 * Math.PI) / 180
const DEGREES = Math.PI / 180

type OrientationPermission = { requestPermission: () => Promise<PermissionState> }

function hasPermissionRequest(value: object): value is OrientationPermission {
  return 'requestPermission' in value && typeof value.requestPermission === 'function'
}

/**
 * Steering-wheel lean of the screen, in [-1, 1], positive when leaning right.
 * Uses gravity projected onto the screen plane, which stays continuous where the
 * beta/gamma Euler angles lock (an upright phone). Null when the phone lies flat.
 */
export function screenLean(betaDegrees: number, gammaDegrees: number, screenAngle: number) {
  const beta = betaDegrees * DEGREES,
    gamma = gammaDegrees * DEGREES,
    angle = screenAngle * DEGREES
  const gx = Math.cos(beta) * Math.sin(gamma),
    gy = -Math.sin(beta)
  const sx = gx * Math.cos(angle) - gy * Math.sin(angle),
    sy = gx * Math.sin(angle) + gy * Math.cos(angle)
  if (Math.hypot(sx, sy) < 0.35) return null
  const roll = Math.atan2(sx, -sy)
  const magnitude = Math.max(0, Math.abs(roll) - DEAD_ZONE) / (RANGE - DEAD_ZONE)
  return Math.sign(roll) * Math.min(1, magnitude)
}

export class DeviceTilt {
  /** Latest lean in [-1, 1]; holds its last value while the phone lies flat. */
  value = 0
  active = false
  private started = false
  private listening = false
  private disposed = false
  private stopAsking = () => {}

  start() {
    if (this.started || typeof DeviceOrientationEvent === 'undefined') return
    this.started = true
    const permission: object = DeviceOrientationEvent
    if (!hasPermissionRequest(permission)) {
      this.listen()
      return
    }
    // iOS only grants orientation access from inside a user gesture.
    const ask = async () => {
      this.stopAsking()
      if (this.disposed) return
      try {
        if ((await permission.requestPermission()) === 'granted') this.listen()
      } catch {
        /* Denied or unavailable: touch parallax still works. */
      }
    }
    const onGesture = () => void ask()
    window.addEventListener('touchend', onGesture, { passive: true })
    window.addEventListener('click', onGesture)
    this.stopAsking = () => {
      window.removeEventListener('touchend', onGesture)
      window.removeEventListener('click', onGesture)
    }
  }

  private listen() {
    if (this.listening || this.disposed) return
    this.listening = true
    window.addEventListener('deviceorientation', this.onOrientation)
  }

  private onOrientation = (event: DeviceOrientationEvent) => {
    if (event.beta === null || event.gamma === null) return
    const lean = screenLean(event.beta, event.gamma, screen.orientation?.angle ?? 0)
    if (lean === null) return
    this.value = lean
    this.active = true
  }

  dispose() {
    this.disposed = true
    this.stopAsking()
    window.removeEventListener('deviceorientation', this.onOrientation)
  }
}
