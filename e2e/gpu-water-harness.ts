import { positionLocal, uniform, uv, vec2, vec4 } from 'three/tsl'
import {
  DataUtils,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  WebGPURenderer,
} from 'three/webgpu'

import { required } from '../src/invariant'
import { createLakeBed, LAKE_BOUNDS } from '../src/scene/lake-bed'
import {
  WaterSimulation,
  WATER_STEP,
  WATER_DAMPING,
  WAVE_SPEED,
} from '../src/scene/water-simulation'
import { createWindNodes, sampleWindField, windFieldNode } from '../src/scene/water-surface'
import { updateWindUniforms, WindModel } from '../src/scene/wind'

interface WaterVerification {
  backend: 'webgpu'
  verify(steps?: number): Promise<{
    maxError: number
    height: number
    velocity: number
    finite: boolean
    energy: number
    laterEnergy: number
  }>
  dispose(): Promise<void>
  verifyWind(): Promise<{ samples: number; maxErrors: readonly number[] }>
}
declare global {
  interface Window {
    gpuWater?: WaterVerification
    gpuWaterError?: string
  }
}

const half = (value: number) => DataUtils.fromHalfFloat(DataUtils.toHalfFloat(value))
const stats = (state: Float32Array) => {
  let height = 0,
    velocity = 0,
    finite = true,
    energy = 0
  for (let i = 0; i < state.length; i += 2) {
    const h = required(state[i]),
      v = required(state[i + 1])
    height = Math.max(height, Math.abs(h))
    velocity = Math.max(velocity, Math.abs(v))
    finite &&= Number.isFinite(h) && Number.isFinite(v)
    energy += h * h + v * v
  }
  return { height, velocity, finite, energy }
}

async function main() {
  const canvas = document.querySelector('#gpu-water')
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing verification canvas')
  if (!navigator.gpu) throw new Error('The water verification requires WebGPU')
  const renderer = new WebGPURenderer({ canvas, antialias: false })
  await renderer.init()
  if (!('isWebGPUBackend' in renderer.backend)) {
    await renderer.dispose()
    throw new Error('The water verification requires a genuine WebGPU backend')
  }
  const simulation = new WaterSimulation(renderer, createLakeBed([], 42, true), true)
  await simulation.compileAsync()
  const n = simulation.resolution,
    dx = LAKE_BOUNDS.size / n
  window.gpuWater = {
    backend: 'webgpu',
    async verifyWind() {
      const size = 32
      const target = new RenderTarget(size, size, { type: FloatType, depthBuffer: false })
      const material = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false })
      const geometry = new PlaneGeometry(2, 2)
      const scene = new Scene()
      const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
      const nodes = createWindNodes()
      const footprint = uniform(0)
      const wind = new WindModel(42)
      material.vertexNode = vec4(positionLocal, 1)
      material.fragmentNode = windFieldNode(
        uv().flipY().mul(128).add(vec2(-64, -96)),
        footprint,
        nodes,
      )
      scene.add(new Mesh(geometry, material))
      const maxErrors = [0, 0, 0, 0]
      let samples = 0
      try {
        renderer.setRenderTarget(target)
        await renderer.compileAsync(scene, camera)
        // Each readback belongs to a distinct frame of the same public material.
        /* eslint-disable no-await-in-loop */
        for (const time of [0, 5, 60]) {
          const state = wind.sample(time)
          nodes.uTime.value = time
          updateWindUniforms(nodes, state)
          for (const coverage of [0, 0.05, 0.5]) {
            footprint.value = coverage
            renderer.render(scene, camera)
            const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size)
            if (!(pixels instanceof Float32Array)) throw new Error('Expected float wind readback')
            for (let row = 0; row < size; row++)
              for (let col = 0; col < size; col++) {
                const reference = sampleWindField(
                  ((col + 0.5) / size) * 128 - 64,
                  ((row + 0.5) / size) * 128 - 96,
                  time,
                  state,
                  coverage,
                )
                for (let component = 0; component < 4; component++) {
                  const actual = required(pixels[(row * size + col) * 4 + component])
                  if (!Number.isFinite(actual)) throw new Error('Nonfinite wind field')
                  maxErrors[component] = Math.max(
                    required(maxErrors[component]),
                    Math.abs(actual - required(reference[component])),
                  )
                }
                samples++
              }
          }
        }
        /* eslint-enable no-await-in-loop */
        return { samples, maxErrors }
      } finally {
        renderer.setRenderTarget(null)
        geometry.dispose()
        material.dispose()
        target.dispose()
      }
    },
    async verify(steps = 24) {
      simulation.reset()
      const radius = dx * 4,
        strength = 0.45
      const x = LAKE_BOUNDS.minX + (n / 2 + 0.5) * dx
      const z = LAKE_BOUNDS.minZ + (n / 2 + 0.5) * dx
      simulation.addImpulse(x, z, radius, strength)
      let previous = new Float32Array(n * n * 2),
        next = new Float32Array(previous.length)
      for (let row = 0; row < n; row++)
        for (let col = 0; col < n; col++) {
          const q = ((col - n / 2) ** 2 + (row - n / 2) ** 2) / 16
          if (q < 1) previous[(row * n + col) * 2 + 1] = half(strength * (1 - q) ** 2 * (1 - 4 * q))
        }
      for (let step = 0; step < steps; step++) {
        for (let row = 1; row < n - 1; row++)
          for (let col = 1; col < n - 1; col++) {
            const i = (row * n + col) * 2
            const h = required(previous[i]),
              v = required(previous[i + 1])
            let sum = -20 * h
            for (const [ox, oy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
              [1, 1],
              [-1, -1],
              [1, -1],
              [-1, 1],
            ] as const)
              sum += required(previous[i + (oy * n + ox) * 2]) * (ox === 0 || oy === 0 ? 4 : 1)
            const velocity =
              (v + ((sum / 6) * WAVE_SPEED ** 2 * WATER_STEP) / dx ** 2) *
              Math.exp(-WATER_DAMPING * WATER_STEP)
            next[i] = half(h + velocity * WATER_STEP)
            next[i + 1] = half(velocity)
          }
        ;[previous, next] = [next, previous]
        simulation.step(WATER_STEP)
      }
      const result = await simulation.snapshot(),
        initial = stats(result.state)
      let maxError = 0
      for (let i = 0; i < previous.length; i++)
        maxError = Math.max(maxError, Math.abs(required(previous[i]) - required(result.state[i])))
      for (let step = 0; step < 120; step++) simulation.step(WATER_STEP)
      const later = stats((await simulation.snapshot()).state)
      return { ...initial, maxError, laterEnergy: later.energy }
    },
    async dispose() {
      simulation.dispose()
      await renderer.dispose()
    },
  }
}
main().catch((error: unknown) => {
  window.gpuWaterError = error instanceof Error ? error.message : String(error)
})
