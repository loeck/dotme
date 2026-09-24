import { float, positionLocal } from 'three/tsl'
import {
  Box3,
  InstancedBufferGeometry,
  Matrix4,
  PerspectiveCamera,
  Vector3,
  Vector4,
  WebGPUCoordinateSystem,
} from 'three/webgpu'
import { describe, expect, it, vi } from 'vitest'

import { WaterfallFluidPass } from './waterfall-fluid-pass'

function createPass(mobile = false) {
  const geometry = new InstancedBufferGeometry()
  const bounds = new Box3(new Vector3(-0.8, -1, -0.5), new Vector3(0.8, 1, 0.5))
  const pass = new WaterfallFluidPass(
    {
      geometry,
      bounds,
      positionNode: positionLocal,
      chordNode: float(0.2),
      aerationNode: float(0.5),
    },
    mobile,
  )
  return { pass, geometry, bounds }
}

function cameraFor(mirrored: boolean) {
  const camera = new PerspectiveCamera(54, 16 / 9, 0.1, 100)
  camera.coordinateSystem = WebGPUCoordinateSystem
  camera.position.set(0, mirrored ? -2.3 : 2.3, 12)
  camera.lookAt(0, 0.5, -6)
  camera.updateMatrixWorld()
  camera.updateProjectionMatrix()
  if (mirrored) {
    // ReflectorNode changes the near clipping row without refreshing its inverse.
    camera.projectionMatrix.elements[2] = 0.08
    camera.projectionMatrix.elements[6] = -0.16
    camera.projectionMatrix.elements[10] = -1.03
    camera.projectionMatrix.elements[14] = -0.3
  }
  return camera
}

describe('waterfall fluid capture', () => {
  it.each([false, true])(
    'reconstructs linear depth through the cropped projection (mirrored=%s)',
    (mirrored) => {
      const { pass, geometry, bounds } = createPass()
      const camera = cameraFor(mirrored)
      const parent = new Matrix4().makeRotationY(0.7)
      parent.setPosition(-2, 1.4, -5)
      expect(pass.updateCamera(camera, parent)).toBe(true)
      const croppedProjection = pass.projectionInverse.clone().invert()
      const inverseParent = parent.clone().invert()
      for (const point of [bounds.min, bounds.max, bounds.getCenter(new Vector3())]) {
        const world = point.clone().applyMatrix4(parent)
        const view = world.clone().applyMatrix4(camera.matrixWorldInverse)
        const original = new Vector4(view.x, view.y, view.z, 1).applyMatrix4(
          camera.projectionMatrix,
        )
        const cropped = new Vector4(view.x, view.y, view.z, 1).applyMatrix4(croppedProjection)
        const u = (cropped.x / cropped.w + 1) / 2
        const v = (1 - cropped.y / cropped.w) / 2
        expect(u).toBeGreaterThan(0)
        expect(u).toBeLessThan(1)
        expect(v).toBeGreaterThan(0)
        expect(v).toBeLessThan(1)
        expect(pass.uvRect.x + u * pass.uvRect.z).toBeCloseTo((original.x / original.w + 1) / 2, 10)
        expect(pass.uvRect.y + v * pass.uvRect.w).toBeCloseTo((1 - original.y / original.w) / 2, 10)
        const ray = new Vector4(u * 2 - 1, 1 - v * 2, 0.5, 1).applyMatrix4(pass.projectionInverse)
        const restored = new Vector3(ray.x / ray.w, ray.y / ray.w, ray.z / ray.w)
        restored
          .multiplyScalar(view.z / restored.z)
          .applyMatrix4(pass.cameraWorld)
          .applyMatrix4(inverseParent)
        expect(restored.distanceTo(point)).toBeLessThan(1e-8)
      }
      expect(pass.captureSize.toArray()).toEqual([192, 192])
      pass.dispose()
      geometry.dispose()
    },
  )

  it('rejects offscreen bounds and conservatively captures bounds crossing the camera plane', () => {
    const { pass, geometry } = createPass(true)
    const camera = new PerspectiveCamera(54, 1, 0.1, 100)
    camera.coordinateSystem = WebGPUCoordinateSystem
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    expect(pass.updateCamera(camera, new Matrix4().makeTranslation(0, 0, 5))).toBe(false)
    expect(pass.updateCamera(camera, new Matrix4().makeTranslation(100, 0, -5))).toBe(false)
    expect(pass.updateCamera(camera, new Matrix4().makeTranslation(0, 0, -0.1))).toBe(true)
    expect(pass.uvRect.toArray()).toEqual([0, 0, 1, 1])
    expect(pass.captureSize.toArray()).toEqual([128, 128])
    pass.dispose()
    geometry.dispose()
  })

  it.each([false, true])(
    'keeps texture storage fixed across portrait and reflected views (mobile=%s)',
    (mobile) => {
      const { pass, geometry } = createPass(mobile)
      const parent = new Matrix4().makeTranslation(-2, 1.4, -5)
      const camera = cameraFor(false)
      camera.aspect = 2.5
      camera.updateProjectionMatrix()
      expect(pass.updateCamera(camera, parent)).toBe(true)
      const depth = pass.depthTexture
      const thickness = pass.thicknessTexture
      const rectangle = pass.uvRect.clone()
      const projection = pass.projectionInverse.clone()
      const mirror = cameraFor(true)
      // Preserve the oblique clipping row while changing the horizontal field of view.
      mirror.projectionMatrix.elements[0] *= 16 / 9 / 0.6
      expect(pass.updateCamera(mirror, parent)).toBe(true)
      expect(pass.uvRect.equals(rectangle)).toBe(false)
      expect(pass.projectionInverse.equals(projection)).toBe(false)
      expect(pass.depthTexture).toBe(depth)
      expect(pass.thicknessTexture).toBe(thickness)
      const size = mobile ? 128 : 192
      expect(pass.captureSize.toArray()).toEqual([size, size])
      for (const texture of [depth, thickness]) {
        const image: unknown = texture.image
        expect(image).toMatchObject({ width: size, height: size })
      }
      expect(pass.updateCamera(camera, parent)).toBe(true)
      expect(pass.captureSize.toArray()).toEqual([size, size])
      expect(pass.depthTexture).toBe(depth)
      expect(pass.thicknessTexture).toBe(thickness)
      pass.dispose()
      geometry.dispose()
    },
  )

  it('can release an uninitialized pass repeatedly without releasing borrowed particle geometry', () => {
    const { pass, geometry } = createPass()
    const release = vi.fn<() => void>()
    geometry.addEventListener('dispose', release)
    pass.dispose()
    pass.dispose()
    expect(pass.updateCamera(cameraFor(false), new Matrix4())).toBe(false)
    expect(release).not.toHaveBeenCalled()
    geometry.dispose()
    expect(release).toHaveBeenCalledOnce()
  })
})
