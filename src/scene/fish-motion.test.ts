import { describe, expect, it } from 'vitest'

import { advanceFishMotion, createFishMotion } from './fish-motion'
import type { FishMotionState } from './fish-motion'

const home = { x: 2, z: -4, radius: 1.35 }

describe('fish steering', () => {
  it('preserves the supplied pose and gives seeded strokes, glides and exploratory turns', () => {
    const initial = createFishMotion(2.2, -4.35, 1.4, 42)
    expect(initial.x).toBe(2.2)
    expect(initial.z).toBe(-4.35)
    expect(initial.heading).toBe(1.4)
    const repeated = createFishMotion(2.2, -4.35, 1.4, 42)
    const different = createFishMotion(2.2, -4.35, 1.4, 43)
    let minimumSpeed = Infinity,
      maximumSpeed = 0,
      minimumTurn = Infinity,
      maximumTurn = -Infinity
    let minimumEffort = Infinity,
      maximumEffort = 0
    for (let frame = 0; frame < 60 * 60; frame++) {
      advanceFishMotion(initial, home, 1 / 60)
      advanceFishMotion(repeated, home, 1 / 60)
      advanceFishMotion(different, home, 1 / 60)
      if (frame < 300) continue
      minimumSpeed = Math.min(minimumSpeed, initial.speed)
      maximumSpeed = Math.max(maximumSpeed, initial.speed)
      minimumTurn = Math.min(minimumTurn, initial.turnRate)
      maximumTurn = Math.max(maximumTurn, initial.turnRate)
      minimumEffort = Math.min(minimumEffort, initial.effort)
      maximumEffort = Math.max(maximumEffort, initial.effort)
    }
    expect(initial).toEqual(repeated)
    expect(initial.x).not.toBe(different.x)
    expect(maximumSpeed).toBeGreaterThan(minimumSpeed * 2)
    expect(minimumTurn).toBeLessThan(-0.5)
    expect(maximumTurn).toBeGreaterThan(0.5)
    expect(maximumEffort - minimumEffort).toBeGreaterThan(0.25)
  })

  it('keeps indefinite escape inside the checked home with bounded speed, acceleration and turning', () => {
    for (const seed of [0, 1, 8, 13]) {
      const state = createFishMotion(2.2, -4.35, seed, seed, {
        cruiseSpeed: seed % 2 ? 0.18 : 0.3,
        burstSpeed: seed % 2 ? 0.6 : 1.2,
        agility: seed % 2 ? 2 : 0.5,
      })
      let maximumRadius = 0,
        maximumAcceleration = 0,
        maximumTurn = 0
      let maximumStep = 0
      for (let frame = 1; frame <= 60 * 120; frame++) {
        const time = frame / 60
        // Includes sustained center hover, moving contact, and sudden reversals.
        const pointer =
          frame < 60 * 40
            ? home
            : {
                x: home.x + Math.sin(time * 1.7) * 1.8,
                z: home.z + Math.cos(time * 1.1) * 1.8,
              }
        const previousX = state.x,
          previousZ = state.z
        const previousSpeed = state.speed,
          previousHeading = state.heading
        advanceFishMotion(state, home, 1 / 60, pointer)
        maximumRadius = Math.max(maximumRadius, Math.hypot(state.x - home.x, state.z - home.z))
        maximumAcceleration = Math.max(
          maximumAcceleration,
          Math.abs(state.speed - previousSpeed) * 60,
        )
        maximumTurn = Math.max(maximumTurn, Math.abs(state.heading - previousHeading) * 60)
        maximumStep = Math.max(maximumStep, Math.hypot(state.x - previousX, state.z - previousZ))
        expect(Number.isFinite(state.tailPhase + state.roll + state.effort)).toBe(true)
      }
      expect(maximumRadius).toBeLessThanOrEqual(home.radius + 1e-10)
      expect(maximumAcceleration).toBeLessThanOrEqual(state.behavior.acceleration + 1e-10)
      expect(maximumTurn).toBeLessThanOrEqual(state.behavior.agility + 1e-10)
      expect(maximumStep).toBeLessThanOrEqual(state.behavior.burstSpeed / 60 + 1e-10)
      expect(Math.abs(state.roll)).toBeLessThanOrEqual(0.22)
    }
  })

  it('smoothly starts and releases alert, including exact contact and strength zero', () => {
    const state = createFishMotion(home.x, home.z, 1.4, 42)
    for (let i = 0; i < 120; i++) advanceFishMotion(state, home, 1 / 60)
    const pointer = { x: state.x, z: state.z }
    const before = { x: state.x, z: state.z, heading: state.heading, tail: state.tailPhase }
    advanceFishMotion(state, home, 1 / 60, pointer)
    expect(state.alert).toBeGreaterThan(0)
    expect(state.alert).toBeLessThan(0.1)
    expect(Math.hypot(state.x - before.x, state.z - before.z)).toBeLessThan(0.01)
    expect(Math.abs(state.heading - before.heading)).toBeLessThan(state.behavior.agility / 60)
    expect(state.tailPhase).toBeGreaterThan(before.tail)
    for (let i = 0; i < 120; i++) advanceFishMotion(state, home, 1 / 60, pointer)
    const alert = state.alert
    expect(alert).toBeGreaterThan(0.5)
    advanceFishMotion(state, home, 1 / 60, { ...pointer, strength: 0 })
    expect(state.alert).toBeLessThan(alert)
    expect(state.alert).toBeGreaterThan(alert * 0.95)
    for (let i = 0; i < 60 * 8; i++) advanceFishMotion(state, home, 1 / 60)
    expect(state.alert).toBeLessThan(0.001)
    expect(Math.hypot(state.fleeX, state.fleeZ)).toBeLessThan(0.001)
  })

  it('tracks the same cursor trajectory at 30, 60 and 144 Hz', () => {
    const results: FishMotionState[] = []
    for (const hz of [30, 60, 144]) {
      const state = createFishMotion(2.2, -4.35, 1.4, 42)
      for (let i = 1; i <= hz * 20; i++) {
        const time = i / hz
        const pointer =
          time > 4 && time < 12
            ? {
                x: home.x + Math.sin(time * 0.6) * 0.8,
                z: home.z + Math.cos(time * 0.8) * 0.8,
              }
            : null
        advanceFishMotion(state, home, 1 / hz, pointer)
      }
      results.push(state)
    }
    for (const state of results.slice(1)) {
      expect(Math.hypot(state.x - results[0]!.x, state.z - results[0]!.z)).toBeLessThan(0.025)
      expect(Math.abs(state.heading - results[0]!.heading)).toBeLessThan(0.03)
      expect(Math.abs(state.speed - results[0]!.speed)).toBeLessThan(0.003)
      expect(Math.abs(state.tailPhase - results[0]!.tailPhase)).toBeLessThan(0.15)
    }
  })

  it('separates neighboring fish gently and brakes an outward-facing fish at the boundary', () => {
    const first = createFishMotion(home.x - 0.1, home.z, 0, 12)
    const second = createFishMotion(home.x + 0.1, home.z, 0, 12)
    for (let i = 0; i < 120; i++) {
      const previousFirst = { x: first.x, z: first.z }
      advanceFishMotion(first, home, 1 / 60, null, second)
      advanceFishMotion(second, home, 1 / 60, null, previousFirst)
    }
    expect(Math.hypot(first.x - second.x, first.z - second.z)).toBeGreaterThan(0.3)
    const edge = createFishMotion(home.x + home.radius, home.z, Math.PI / 2, 13)
    for (let i = 0; i < 300; i++) {
      advanceFishMotion(edge, home, 1 / 60, home)
      expect(Math.hypot(edge.x - home.x, edge.z - home.z)).toBeLessThanOrEqual(home.radius + 1e-10)
    }
    expect(edge.speed).toBeGreaterThan(0)
  })

  it('does not animate when skipped or given zero/invalid elapsed time', () => {
    const state = createFishMotion(2.2, -4.35, 1.4, 42)
    const initial = structuredClone(state)
    for (const dt of [0, -1, NaN, Infinity]) advanceFishMotion(state, home, dt, home)
    expect(state).toEqual(initial)
    // Hidden-tab gaps are bounded rather than fast-forwarding through a habitat.
    advanceFishMotion(state, home, 100, home)
    expect(state.elapsed).toBeCloseTo(0.1)
    expect(Math.hypot(state.x - initial.x, state.z - initial.z)).toBeLessThan(0.01)
  })
})
