import { DataUtils, WebGLRenderer } from 'three'

import { LAKE_BOUNDS } from '../src/scene/lake-bed'
import { WaterSimulation } from '../src/scene/water-simulation'
import { WindModel, WIND_BEARING } from '../src/scene/wind'
export { VoxelLandscapeEngine } from '../src/scene/VoxelLandscapeEngine'

export async function exerciseSimulation() {
  const renderer = new WebGLRenderer()
  renderer.setSize(8, 8)
  const n = 256
  const mask = new Uint8Array(n * n).fill(255)
  // An unbroken shore divides the domain. No wave may cross it.
  for (let z = 0; z < n; z++) mask[z * n + 128] = 0
  const bed = {
    resolution: n,
    water: mask,
    depth: new Float32Array(n * n).fill(2),
    obstacle: new Float32Array(n * n),
    shore: new Float32Array([2]),
    stones: [],
  }
  let simulation = new WaterSimulation(renderer, bed, true)
  const read = async () => {
    // Test-only access to the actual GPU state, including velocity and the entire masked shore.
    const state = simulation as unknown as {
      targets: import('three').WebGLRenderTarget[]
      current: number
    }
    const target = state.targets[state.current]!
    const data = new Uint16Array(512 * 512 * simulation.channels)
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 512, 512, data)
    let signedVolume = 0,
      absoluteVolume = 0
    let energy = 0,
      peak = 0,
      beyond = 0,
      propagated = 0
    for (let z = 0; z < 512; z++)
      for (let x = 0; x < 512; x++) {
        const h = DataUtils.fromHalfFloat(data[(z * 512 + x) * simulation.channels]!)
        const v = DataUtils.fromHalfFloat(data[(z * 512 + x) * simulation.channels + 1]!)
        if (!Number.isFinite(h) || !Number.isFinite(v)) throw new Error('Non-finite GPU water')
        signedVolume += h
        absoluteVolume += Math.abs(h)
        energy += h * h + v * v
        peak = Math.max(peak, Math.abs(h))
        if (x >= 256) beyond = Math.max(beyond, Math.abs(h))
        const worldX = LAKE_BOUNDS.minX + ((x + 0.5) * 160) / 512
        const worldZ = LAKE_BOUNDS.minZ + ((z + 0.5) * 160) / 512
        if (Math.hypot(worldX + 2, worldZ + 32) > 1.3)
          propagated = Math.max(propagated, Math.abs(h))
      }
    return {
      energy,
      peak,
      beyond,
      propagated,
      volumeImbalance: Math.abs(signedVolume) / Math.max(absoluteVolume, 1e-12),
    }
  }
  const supported = simulation.available
  if (!supported) throw new Error('GPU simulation is unavailable in this test browser')
  simulation.addImpulse(-2, -32, 0.8, -0.5)
  simulation.step(1 / 60)
  const initial = await read()
  for (let i = 0; i < 60; i++) simulation.step(1 / 60)
  const spread = await read()
  for (let i = 0; i < 420; i++) simulation.step(1 / 60)
  const settled = await read()
  simulation.reset()
  const reset = await read()
  const sampled: number[] = []
  for (const hz of [30, 60, 144]) {
    simulation.reset()
    simulation.addImpulse(-2, -32, 0.8, -0.5)
    for (let i = 0; i < hz; i++) simulation.step(1 / hz)
    // Each reading follows a different simulation run; these cannot run concurrently.
    // eslint-disable-next-line no-await-in-loop
    sampled.push((await read()).energy)
  }
  const edgeEnergy: number[] = []
  for (const x of [-79, -20]) {
    simulation.reset()
    simulation.addImpulse(x, -32, 0.8, -0.5)
    for (let i = 0; i < 120; i++) simulation.step(1 / 60)
    // Each read measures the preceding, separate boundary experiment.
    // eslint-disable-next-line no-await-in-loop
    edgeEnergy.push((await read()).energy)
  }
  simulation.reset()
  for (let i = 0; i < 600; i++) simulation.step(1 / 60, i / 60)
  const windContact = await read()
  const windSampled: number[] = []
  for (const hz of [30, 60, 144]) {
    simulation.reset()
    for (let i = 0; i < hz; i++) simulation.step(1 / hz, (i + 1) / hz)
    // Equal elapsed time with forcing enabled, after each separate run.
    // eslint-disable-next-line no-await-in-loop
    windSampled.push((await read()).energy)
  }
  const windScenarios = []
  for (const options of [
    { meanSpeed: 0.6 },
    { meanSpeed: 6 },
    { meanSpeed: 6, bearing: WIND_BEARING + Math.PI },
  ]) {
    simulation.dispose()
    simulation = new WaterSimulation(renderer, bed, true, new WindModel(9182, options))
    for (let i = 0; i < 240; i++) simulation.step(1 / 60, (i + 1) / 60)
    // Stability and solid barriers must also hold under stronger/reversed forcing.
    // eslint-disable-next-line no-await-in-loop
    windScenarios.push(await read())
  }
  // Ambient swell must generate scattering only where a solid interrupts it.
  mask.fill(255)
  simulation.mask.needsUpdate = true
  simulation.reset()
  for (let i = 0; i < 120; i++) simulation.step(1 / 60, i / 60)
  const openWind = await read()
  simulation.dispose()
  renderer.dispose()
  return {
    supported,
    initial,
    spread,
    settled,
    reset,
    sampled,
    edgeEnergy,
    windContact,
    windSampled,
    windScenarios,
    openWind,
  }
}

import type { PerspectiveCamera, ShaderMaterial, Vector3 } from 'three'

import { VoxelLandscapeEngine } from '../src/scene/VoxelLandscapeEngine'
let engine: VoxelLandscapeEngine | undefined
let impulses = 0
const probe = () =>
  engine as unknown as {
    camera: PerspectiveCamera
    simulation: WaterSimulation
    elapsed: number
    water: { material: ShaderMaterial }
    pointerActive: boolean
    dragging: boolean
    hitWater: (x: number, y: number) => Vector3 | null
  }
export function startEngine(seed: number, reducedMotion: boolean) {
  engine?.dispose()
  engine = new VoxelLandscapeEngine({
    container: document.querySelector('#scene')!,
    seed,
    reducedMotion,
    onFirstFrame() {},
    onContextFailure() {
      throw new Error('WebGL context lost')
    },
  })
  impulses = 0
  const simulation = probe().simulation
  const add = simulation.addImpulse.bind(simulation)
  simulation.addImpulse = (...args) => {
    impulses++
    add(...args)
  }
}
export function diagnostics() {
  const state = probe()
  return {
    impulses,
    elapsed: state.elapsed,
    camera: state.camera.position.toArray(),
    active: state.pointerActive,
    dragging: state.dragging,
    reveal: state.water.material.uniforms.uPointer!.value.z,
    mode: state.simulation.available,
  }
}
export function findWater() {
  for (const y of [0.75, 0.8, 0.7, 0.95, 0.9])
    for (const x of [0.5, 0.55, 0.45, 0.6, 0.65, 0.4, 0.7, 0.35, 0.75, 0.3, 0.8]) {
      const px = x * innerWidth,
        py = y * innerHeight
      // The gesture travels 30px right and the camera eases during contact.
      // Require an open patch, not just a single wet pixel beside a rock.
      const open = [-10, 0, 40].every((dx) =>
        [-12, 0, 12].every((dy) => probe().hitWater(px + dx, py + dy)),
      )
      if (open) return { x: px, y: py }
    }
  throw new Error('No visible water found')
}
export function hit(x: number, y: number) {
  return !!probe().hitWater(x, y)
}
export function stopEngine() {
  engine?.dispose()
  engine = undefined
}
export function resizeEngine() {
  engine?.resize()
}
export function findBank() {
  const state = probe() as ReturnType<typeof probe> & {
    bed: import('../src/scene/lake-bed').LakeBed
  }
  const bed = state.bed
  for (let z = 12; z > -50; z -= 0.5)
    for (let x = -30; x < 30; x += 0.5) {
      const i =
        Math.floor(((z - LAKE_BOUNDS.minZ) / 160) * bed.resolution) * bed.resolution +
        Math.floor(((x - LAKE_BOUNDS.minX) / 160) * bed.resolution)
      if (bed.water[i]) continue
      const position = state.camera.position
        .clone()
        .set(x, bed.obstacle[i]!, z)
        .project(state.camera)
      const px = ((position.x + 1) * innerWidth) / 2,
        py = ((1 - position.y) * innerHeight) / 2
      if (
        px > 10 &&
        px < innerWidth - 10 &&
        py > innerHeight * 0.5 &&
        py < innerHeight - 10 &&
        !state.hitWater(px, py)
      )
        return { x: px, y: py }
    }
  throw new Error('No visible bank')
}

export {
  exerciseAtmosphere,
  startCloudExperiment,
  renderCloudExperiment,
  stopCloudExperiment,
} from './atmosphere-harness'
export { exerciseCloudShadows } from './cloud-shadow-harness'

export function renderCloudShadowComparison(time: number, enabled: boolean) {
  const state = engine as unknown as {
    elapsed: number
    clouds: import('../src/scene/volumetric-clouds').VolumetricClouds
    render: (now: number) => void
  }
  state.elapsed = time
  state.clouds.shadows.uniforms.uCloudShadowStrength.value = enabled ? 0.95 : 0
  state.render(performance.now())
}
