import { WebGLRenderer, DataUtils } from 'three'
import { texture } from 'three/tsl'
import {
  WebGPURenderer,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  OrthographicCamera,
  Scene,
  RenderTarget,
  HalfFloatType,
} from 'three/webgpu'

import { WebGPUWaterSimulation } from '../src/scene/experimental/webgpu-water'
import { WaterSimulation } from '../src/scene/water-simulation'

export async function exerciseCompute() {
  if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) return null
  const n = 256
  const bed = {
    resolution: n,
    water: new Uint8Array(n * n).fill(255),
    depth: new Float32Array(n * n).fill(2),
    obstacle: new Float32Array(n * n),
    shore: new Float32Array([2]),
    stones: [],
  }
  for (let z = 0; z < n; z++) bed.water[z * n + 128] = 0
  const renderer = new WebGPURenderer(),
    glRenderer = new WebGLRenderer()
  const simulation = await WebGPUWaterSimulation.create(renderer, bed, true)
  const reference = new WaterSimulation(glRenderer, bed, true)
  const scene = new Scene(),
    geometry = new PlaneGeometry(2, 2)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const material = new MeshBasicNodeMaterial()
  material.fragmentNode = texture(simulation.texture)
  material.toneMapped = false
  scene.add(new Mesh(geometry, material))
  const target = new RenderTarget(512, 512, { type: HalfFloatType, depthBuffer: false })
  const compare = async () => {
    material.fragmentNode = texture(simulation.texture)
    material.needsUpdate = true
    renderer.setRenderTarget(target)
    await renderer.renderAsync(scene, camera)
    const gpu = new Uint16Array(
      (await renderer.readRenderTargetPixelsAsync(target, 0, 0, 512, 512)).buffer,
    )
    const original = reference as unknown as {
      targets: import('three').WebGLRenderTarget[]
      current: number
    }
    const gl = new Uint16Array(512 * 512 * reference.channels)
    await glRenderer.readRenderTargetPixelsAsync(
      original.targets[original.current]!,
      0,
      0,
      512,
      512,
      gl,
    )
    let maxError = 0,
      energy = 0,
      originalEnergy = 0,
      beyond = 0,
      finite = true
    for (let z = 0; z < 512; z++)
      for (let x = 0; x < 512; x++) {
        // WebGPU render-target readback is top-down; the fullscreen UV flips y.
        const i = ((511 - z) * 512 + x) * 4,
          j = (z * 512 + x) * reference.channels
        for (let c = 0; c < 2; c++) {
          const value = DataUtils.fromHalfFloat(gpu[i + c]!),
            expected = DataUtils.fromHalfFloat(gl[j + c]!)
          finite &&= Number.isFinite(value)
          maxError = Math.max(maxError, Math.abs(value - expected))
          energy += value * value
          originalEnergy += expected * expected
        }
        if (x >= 256) beyond = Math.max(beyond, Math.abs(DataUtils.fromHalfFloat(gpu[i]!)))
      }
    return { maxError, energy, originalEnergy, beyond, finite }
  }
  try {
    simulation.addImpulse(-2, -32, 0.8, -0.5)
    reference.addImpulse(-2, -32, 0.8, -0.5)
    for (let i = 0; i < 60; i++) {
      simulation.step(1 / 60)
      reference.step(1 / 60)
    }
    const impulse = await compare()
    simulation.reset()
    reference.reset()
    for (let i = 0; i < 60; i++) {
      simulation.step(1 / 60, (i + 1) / 60)
      reference.step(1 / 60, (i + 1) / 60)
    }
    const wind = await compare()
    simulation.reset()
    reference.reset()
    const reset = await compare()
    const preview = simulation.createPreviewMaterial()
    const previewGeometry = new PlaneGeometry(160, 160, 32, 32)
    previewGeometry.rotateX(-Math.PI / 2)
    const previewMesh = new Mesh(previewGeometry, preview)
    scene.clear()
    scene.add(previewMesh)
    camera.position.set(0, 10, 0)
    camera.up.set(0, 0, -1)
    camera.lookAt(0, 0, 0)
    await renderer.renderAsync(scene, camera)
    preview.dispose()
    previewGeometry.dispose()
    return { impulse, wind, reset }
  } finally {
    simulation.dispose()
    reference.dispose()
    material.dispose()
    geometry.dispose()
    target.dispose()
    renderer.dispose()
    glRenderer.dispose()
    glRenderer.forceContextLoss()
  }
}
