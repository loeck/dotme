/** One immutable, seeded shape per impact: animation never redraws random values. */
export function createSplashProfile(random: () => number, energy: number) {
  const strength = Math.max(0, Math.min(1, energy))
  const seed = random() * 100
  const fan = 1.0 + random() * 1.1
  const lean = (random() - 0.5) * 0.32
  const lift = 0.65 + random() * 0.6
  const reach = 0.75 + random() * 0.6
  const lifetime = 0.18 + random() * 0.13
  const width = 0.35 + random() * 0.75 + strength * 0.35
  const tear = 0.18 + random() * 0.22
  const emission = 0.06 + random() * 0.16
  const count = 6 + Math.floor(strength * 10 + random() * (4 + strength * 7))
  const jetCount = 2 + Math.floor(random() * (2 + strength * 3))
  const jets = Array.from({ length: jetCount }, (_, index) => ({
    // Stratification spreads the jets, but neither their spacing nor heights repeat.
    angle: ((index + 0.15 + random() * 0.7) / jetCount - 0.5) * fan + lean,
    lift: 0.3 + random() * 0.9,
    speed: 0.8 + random() * 0.4,
    delay: random() * emission * 0.3,
  }))
  return { seed, fan, lean, lift, reach, lifetime, width, tear, emission, count, jets }
}

export type SplashProfile = ReturnType<typeof createSplashProfile>
