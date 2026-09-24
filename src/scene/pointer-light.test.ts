import { Vector3 } from 'three'
import { expect, it } from 'vitest'

import { PointerLight } from './pointer-light'

const direction = new Vector3(0, -0.2, -1).normalize()
const contact = new Vector3(2, 0, -5)

it('fades with darkness and loses illumination when no surface is targeted', () => {
  const light = new PointerLight()
  const strength = () => light.uniforms.uPointerLightStrength.value
  light.update(contact, direction, 0, 1 / 60)
  expect(strength()).toBe(0)
  light.update(contact, direction, 1, 1 / 60)
  expect(strength()).toBeGreaterThan(0)
  expect(strength()).toBeLessThan(0.2)
  const lit = strength()
  light.update(null, direction, 1, 1 / 60)
  expect(strength()).toBeGreaterThan(0)
  expect(strength()).toBeLessThan(lit)
  light.update(null, direction, 1, 2)
  expect(strength()).toBe(0)
})

it('keeps the contact anchored while only intensity eases, including reduced motion', () => {
  const light = new PointerLight()
  light.update(contact, direction, 1, 1 / 60)
  const next = new Vector3(-4, 2, 8)
  light.update(next, direction, 0.6, 0, true)
  expect(light.uniforms.uPointerLightPosition.value.toArray()).toEqual(next.toArray())
  expect(light.uniforms.uPointerLightSource.value.distanceTo(next)).toBeGreaterThan(1)
  expect(light.uniforms.uPointerLightStrength.value).toBe(0.6)
  light.update(null, direction, 0.6, 0, true)
  expect(light.uniforms.uPointerLightStrength.value).toBe(0)
})

it('uses elapsed time rather than frame count to fade', () => {
  const strengths = [30, 60, 144].map((fps) => {
    const light = new PointerLight()
    for (let frame = 0; frame < fps / 3; frame++) light.update(contact, direction, 0.8, 1 / fps)
    return light.uniforms.uPointerLightStrength.value
  })
  for (const strength of strengths) expect(strength).toBeCloseTo(strengths[0]!, 8)
})
