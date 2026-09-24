import { Vector3 } from 'three'
import type { PerspectiveCamera } from 'three'

import { apparentFishSurface } from '../src/scene/fish-pointer'
import type { DetailEnvironment } from '../src/scene/scene-details'
import { VoxelLandscapeEngine } from '../src/scene/VoxelLandscapeEngine'

let engine: VoxelLandscapeEngine | undefined

export async function start(seed = 42, details = true, reducedMotion = false, rainIntensity = 0) {
  stop()
  await new Promise<void>((resolve, reject) => {
    engine = new VoxelLandscapeEngine({
      container: document.querySelector<HTMLDivElement>('#scene')!,
      seed,
      sceneDetails: details,
      reducedMotion,
      rain: { intensity: rainIntensity, wind: { x: 2, z: 0.5 } },
      onFirstFrame: resolve,
      onContextFailure: () => reject(new Error('Scene context failed')),
    })
  })
}

export function environment(state: Partial<DetailEnvironment>) {
  engine!.setDetailEnvironment(state)
}

export function rain(intensity: number) {
  engine!.setRainState({ intensity, wind: { x: 2, z: 0.5 } })
}

export function resize() {
  engine!.resize()
}

export function fishProbe(visible = true) {
  const state = engine as unknown as {
    camera: PerspectiveCamera
    details: {
      fish: { mesh: { visible: boolean }; poses: Array<{ x: number; y: number; z: number }> }
    }
  }
  const fish = state.details.fish
  fish.mesh.visible = visible
  const pose = fish.poses.find((point) => point.z > -15) ?? fish.poses[0]!
  const point = apparentFishSurface(pose, state.camera.position, new Vector3())
  point.project(state.camera)
  engine!.resize()
  return { x: (point.x * 0.5 + 0.5) * innerWidth, y: (-point.y * 0.5 + 0.5) * innerHeight }
}

export function status() {
  // Diagnostics stay in this test-only harness, outside the site's public API.
  const state = engine as unknown as {
    elapsed: number
    details?: {
      fish: { count: number }
      fireflies: { mesh: { geometry: { instanceCount: number } } }
      mist: { mesh: { geometry: { instanceCount: number } } }
      wetness: { wetness: number }
      environment: DetailEnvironment
    }
    renderer: { info: { memory: { geometries: number; textures: number } } }
  }
  return {
    time: state.elapsed,
    fish: state.details?.fish.count ?? 0,
    fireflies: state.details?.fireflies.mesh.geometry.instanceCount ?? 0,
    mist: state.details?.mist.mesh.geometry.instanceCount ?? 0,
    wetness: state.details?.wetness.wetness ?? 0,
    environment: state.details?.environment,
    memory: { ...state.renderer.info.memory },
  }
}

export function stop() {
  engine?.dispose()
  engine = undefined
}
