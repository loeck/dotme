import { PerspectiveCamera } from 'three'
import { expect, it } from 'vitest'

import { ShootingStars, starVisibility } from './stars'

it('reserves stars for full night, fades bright stars first and reverses at dawn', () => {
  expect(starVisibility(0.1)).toBe(0)
  expect(starVisibility(0)).toBe(0)
  for (const height of [-0.02, -0.07, -0.12]) expect(starVisibility(height)).toBe(0)
  expect(starVisibility(-0.2, 1)).toBeGreaterThan(starVisibility(-0.2, 0.1))
  expect(starVisibility(-0.4, 0.1)).toBe(1)
  const dusk = [0, -0.12, -0.2, -0.4].map((h) => starVisibility(h))
  expect(dusk).toEqual(dusk.toSorted((a, b) => a - b))
})
it('keeps seeded 90–180 second attempts independent of solar speed, with one short event', () => {
  const camera = new PerspectiveCamera(54, 16 / 9, 0.1, 500)
  camera.position.set(0, 2.3, 16)
  camera.lookAt(0, 7.3, -25)
  camera.updateMatrixWorld()
  const stars = new ShootingStars(42),
    repeat = new ShootingStars(42)
  expect(stars.remaining).toBe(repeat.remaining)
  let last = 0,
    previous = 0
  const events: Array<{ interval: number; startY: number; endY: number; age: number }> = []
  for (let i = 0; i < 36000; i++) {
    stars.advance(1 / 60, -0.5, false, false, camera)
    repeat.advance(1 / 60, -0.5, false, false, camera)
    if (stars.attempts > previous) {
      events.push({
        interval: i / 60 - last,
        startY: stars.start.y,
        endY: stars.end.y,
        age: stars.age,
      })
      previous = stars.attempts
      last = i / 60
    }
  }
  for (const event of events) {
    expect(event.interval).toBeGreaterThanOrEqual(89.98)
    expect(event.interval).toBeLessThanOrEqual(180)
    expect(event.startY).toBeGreaterThan(0.15)
    expect(event.endY).toBeGreaterThan(0.15)
    expect(event.age).toBe(0)
  }
  expect(stars.attempts).toBeGreaterThan(2)
  expect(stars.start).toEqual(repeat.start)
  const remaining = stars.remaining
  for (let i = 0; i < 100; i++) stars.advance(1, -0.1, false, false, camera)
  for (let i = 0; i < 100; i++) stars.advance(1, 0, false, false, camera)
  for (let i = 0; i < 100; i++) stars.advance(1, -0.5, true, false, camera)
  for (let i = 0; i < 100; i++) stars.advance(1, -0.5, false, true, camera)
  expect(stars.remaining).toBe(remaining)
  expect(stars.age).toBe(2)
})

it('answers a wish on the night sky with a short run of meteors from that point', () => {
  const camera = new PerspectiveCamera(54, 16 / 9, 0.1, 500)
  camera.position.set(0, 2.3, 16)
  camera.lookAt(0, 7.3, -25)
  camera.updateMatrixWorld()
  const stars = new ShootingStars(7)
  const scheduled = stars.remaining
  expect(stars.wish(0.3, 0.5)).toBe(true)
  // A second wish while the first is falling is ignored.
  expect(stars.wish(-0.3, 0.5)).toBe(false)
  const starts: Array<{ x: number; y: number }> = []
  for (let i = 0; i < 60 * 6; i++) {
    stars.advance(1 / 60, -0.5, false, false, camera)
    if (stars.age === 0) starts.push(stars.start.clone().add(camera.position).project(camera))
  }
  // Each falls from near the wished point.
  for (const start of starts) {
    expect(Math.abs(start.x - 0.3)).toBeLessThan(0.1)
    expect(Math.abs(start.y - 0.5)).toBeLessThan(0.1)
  }
  const launches = starts.length
  expect(launches).toBe(3)
  // Wishes do not count against, or delay, the sky's own meteors beyond the time that passed.
  expect(stars.remaining).toBeLessThan(scheduled)
  expect(stars.attempts).toBe(0)
  // Daylight or clouds drop a pending wish.
  stars.wish(0, 0.5)
  stars.advance(1 / 60, 0.3, false, false, camera)
  for (let i = 0; i < 600; i++) stars.advance(1 / 60, -0.5, false, false, camera)
  expect(stars.attempts).toBe(0)
})
