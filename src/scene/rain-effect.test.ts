import { DirectionalLight, Mesh, PerspectiveCamera } from 'three'
import type { InstancedBufferGeometry } from 'three'
import { expect, it } from 'vitest'

import { RAIN_EXPOSURE } from './rain-shaders'
import { RAIN_STEP, WATER_Y } from './rain-simulation'
import { RainEffect } from './RainEffect'
import { createWindUniforms, WindModel } from './wind'

function fixture(size: number) {
  const rain = new RainEffect(
    [],
    true,
    42,
    [],
    new DirectionalLight(),
    false,
    {
      ...createWindUniforms(),
      uTime: { value: 0 },
      uState: { value: null },
      uMask: { value: null },
      uCell: { value: 0.16 },
    },
    false,
  )
  rain.setRainState({ intensity: 0.001, wind: { x: 0, z: 0 } })
  Object.assign(rain.simulation.drops[0]!, {
    alive: true,
    x: 1,
    y: WATER_Y + 0.025,
    z: -3,
    vx: 0,
    vy: -8,
    vz: 0,
    size,
    seed: 0.1,
  })
  const camera = new PerspectiveCamera()
  camera.position.set(0, 2, 10)
  const geometry = (index: number) =>
    (rain.group.children[index] as Mesh).geometry as InstancedBufferGeometry
  return { rain, camera, geometry }
}

it('joins the last exposure segment to the same contact that creates the surface impact', () => {
  const { rain, camera, geometry } = fixture(0.004)
  rain.update(RAIN_STEP, camera, 1)
  expect(rain.simulation.drops[0]!.alive).toBe(false)
  const impact = rain.simulation.impacts[0]!
  const drops = geometry(0)
  expect(drops.instanceCount).toBe(1)
  const head = drops.getAttribute('aDrop')
  expect(head.getX(0)).toBeCloseTo(impact.x)
  expect(head.getY(0)).toBeCloseTo(impact.y)
  expect(head.getZ(0)).toBeCloseTo(impact.z)
  const age = drops.getAttribute('aContactAge').getX(0)
  expect(age).toBeGreaterThan(0)
  expect(age).toBeLessThan(RAIN_EXPOSURE)
  expect(drops.getAttribute('aVelocity').getY(0)).toBe(impact.vy)
  const crown = geometry(1).getAttribute('aImpact')
  expect(crown.getX(0)).toBe(impact.x)
  expect(crown.getY(0)).toBe(impact.z)
  rain.update(0.02, camera, 1)
  expect(drops.instanceCount).toBe(0)
  rain.dispose()
})

it('keeps small-drop impacts as surface ripples and reserves visible ejection for energetic drops', () => {
  const small = fixture(0.0008),
    large = fixture(0.004)
  for (const { rain, camera } of [small, large]) rain.update(RAIN_STEP, camera, 1)
  expect(Number.isFinite(small.rain.simulation.impacts[0]!.born)).toBe(true)
  expect(small.geometry(1).instanceCount).toBe(0)
  expect(small.geometry(2).instanceCount).toBe(0)
  expect(large.geometry(1).instanceCount).toBe(1)
  expect(large.geometry(2).instanceCount).toBeGreaterThan(0)
  small.rain.dispose()
  large.rain.dispose()
})

it('keeps the lake and collision clocks aligned when a frame contains a fractional simulation step', () => {
  const wind = new WindModel(42, { meanSpeed: 3, gustStrength: 0, turnStrength: 0 }).sample(0)
  const contacts = [30, 60, 144].map((fps) => {
    const { rain, camera } = fixture(0.004)
    rain.simulation.drops[0]!.y = WATER_Y + 0.35
    for (let frame = 1; frame <= fps / 3; frame++)
      rain.update(1 / fps, camera, 1, { time: frame / fps, wind })
    const { born, y } = rain.simulation.impacts[0]!
    const impact = { born, y }
    rain.dispose()
    return impact
  })
  for (const contact of contacts.slice(1)) {
    expect(contact.born).toBeCloseTo(contacts[0]!.born, 10)
    expect(contact.y).toBeCloseTo(contacts[0]!.y, 10)
  }
})
