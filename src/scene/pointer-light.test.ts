import { Vector3 } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { expect, it } from 'vitest'

import { PointerLight } from './pointer-light'

const direction = new Vector3(0, -0.2, -1).normalize()
const contact = new Vector3(2, 0, -5)

it('fades with night strength and loses illumination when no surface is targeted', () => {
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

it('rekindles instead of teleporting when the surface under the cursor jumps in depth', () => {
  const light = new PointerLight()
  const strength = () => light.uniforms.uPointerLightStrength.value
  light.update(contact, direction, 1, 0, true)
  // A small step across the same surface keeps the light whole.
  const beside = contact.clone().add(new Vector3(0.3, 0, 0.2))
  light.update(beside, direction, 1, 1 / 60)
  expect(strength()).toBe(1)
  // Crossing the bank's silhouette onto a hill 20 m behind nearly relights from dark.
  const behind = beside.clone().addScaledVector(direction, 20)
  light.update(behind, direction, 1, 1 / 60)
  expect(strength()).toBeLessThan(0.15)
  const dipped = strength()
  for (let frame = 0; frame < 30; frame++) light.update(behind, direction, 1, 1 / 60)
  expect(strength()).toBeGreaterThan(0.95)
  expect(dipped).toBeGreaterThan(0)
  // Reduced motion keeps changes immediate.
  light.update(contact, direction, 1, 0, true)
  expect(strength()).toBe(1)
})

it('keeps its strength while the cursor sweeps smoothly over distant water', () => {
  const origin = new Vector3(0, 2.3, 10)
  const light = new PointerLight()
  const strength = () => light.uniforms.uPointerLightStrength.value
  const point = new Vector3(0, 0, -30)
  light.update(point, point.clone().sub(origin).normalize(), 1, 0, true, origin)
  // About 0.6 m of depth per pixel at 40 m: a 5 px per frame sweep moves ~3 m a frame.
  for (let frame = 0; frame < 60; frame++) {
    point.z -= 3
    light.update(point, point.clone().sub(origin).normalize(), 1, 1 / 60, false, origin)
  }
  expect(strength()).toBeGreaterThan(0.95)
  // Crossing from the near bank to that far water still rekindles.
  const bank = new Vector3(0, 0.5, -2)
  light.update(bank, bank.clone().sub(origin).normalize(), 1, 0, true, origin)
  light.update(point, point.clone().sub(origin).normalize(), 1, 1 / 60, false, origin)
  expect(strength()).toBeLessThan(0.2)
})

it('uses elapsed time rather than frame count to fade', () => {
  const strengths = [30, 60, 144].map((fps) => {
    const light = new PointerLight()
    for (let frame = 0; frame < fps / 3; frame++) light.update(contact, direction, 0.8, 1 / fps)
    return light.uniforms.uPointerLightStrength.value
  })
  for (const strength of strengths) expect(strength).toBeCloseTo(strengths.at(0) ?? 0, 8)
})

it('clears lingering illumination as soon as night ends, even on an accelerated clock', () => {
  const light = new PointerLight()
  light.update(contact, direction, 1, 0, true)
  light.update(contact, direction, 0, 1 / 60)
  expect(light.uniforms.uPointerLightStrength.value).toBe(0)
})

it('keys each light response to its own material program', () => {
  const light = new PointerLight()
  const keys = [undefined, { translucency: 0.6, gain: 4 }, { translucency: 0.5 }].map(
    (response) => {
      const material = new MeshStandardNodeMaterial()
      light.applyTo(material, response)
      const key = material.customProgramCacheKey()
      material.dispose()
      return key
    },
  )
  expect(new Set(keys).size).toBe(keys.length)
})
