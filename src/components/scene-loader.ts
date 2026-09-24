import {
  Fn,
  attribute,
  clamp,
  cos,
  exp,
  float,
  mix,
  normalLocal,
  positionLocal,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl'
import {
  BoxGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three/webgpu'
import type { Node } from 'three/webgpu'

import type { GpuRuntime } from './gpu-runtime'

const CYCLE_DURATION = 4.8
// Two stepped islands with an open channel. Columns share a wave phase so their
// stacked cubes keep the same breathing room throughout the animation.
const CUBE_CENTERS = [
  [-0.69, -0.14, -0.24],
  [-0.69, -0.14, 0.14],
  [-0.31, -0.14, -0.24],
  [-0.31, -0.14, 0.14],
  [-0.69, 0.24, -0.24],
  [0.34, -0.14, -0.43],
  [0.72, -0.14, -0.43],
  [0.34, -0.14, -0.05],
  [0.72, -0.14, -0.05],
  [0.72, 0.24, -0.43],
] as const

const safeRayComponent = (component: Node<'float'>) =>
  component.lessThan(0).select(component.min(-0.0001), component.max(0.0001))

/** A small archipelago and an orbiting firefly, sharing the landscape's renderer. */
export async function initSceneLoader(runtime: GpuRuntime, signal: AbortSignal) {
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  camera.position.set(0, 0, 10)
  const group = new Group()
  group.rotation.set(0.58, -0.63, 0)
  group.position.y = 0.58
  scene.add(group)
  const geometry = new BoxGeometry(0.28, 0.28, 0.28)
  geometry.setAttribute(
    'islandCenter',
    new InstancedBufferAttribute(new Float32Array(CUBE_CENTERS.flat()), 3),
  )
  const center = attribute('islandCenter', 'vec3')
  const material = new MeshBasicNodeMaterial()
  const lightPosition = uniform(new Vector3())
  const sideColor = vec3(0.17, 0.29, 0.35)
  const frontColor = vec3(0.36, 0.51, 0.56)
  const topColor = vec3(0.72, 0.84, 0.85)
  const faces = mix(
    mix(sideColor, frontColor, clamp(normalLocal.z, 0, 1)),
    topColor,
    clamp(normalLocal.y, 0, 1),
  )
  const time = uniform(0)
  const movement = uniform(0)
  const liftAt = (point: Node<'vec3'>) => {
    const phase = time.sub(point.x.mul(2.2)).add(point.z.mul(1.6))
    // Integer harmonics meet with equal position and velocity at the loop seam.
    return sin(phase)
      .mul(0.105)
      .add(cos(phase.mul(2)).mul(0.018))
      .mul(movement)
  }
  material.positionNode = positionLocal.add(center).add(vec3(0, liftAt(center), 0))
  const toLight = lightPosition.sub(positionLocal)
  const distanceSquared = toLight.dot(toLight).max(0.015)
  const illumination = clamp(normalLocal.dot(toLight.normalize()), 0, 1).div(
    distanceSquared.mul(3).add(0.25),
  )
  const visibility = Fn(() => {
    // Trace only the segment to the firefly. The same lift drives geometry and occluders.
    const origin = positionLocal.add(normalLocal.mul(0.003))
    const ray = lightPosition.sub(origin)
    const inverse = vec3(1).div(
      vec3(safeRayComponent(ray.x), safeRayComponent(ray.y), safeRayComponent(ray.z)),
    )
    const visible = float(1).toVar()
    for (const [x, y, z] of CUBE_CENTERS) {
      const block = vec3(x, y, z)
      const animated = block.add(vec3(0, liftAt(block), 0))
      const a = animated.sub(0.14).sub(origin).mul(inverse)
      const b = animated.add(0.14).sub(origin).mul(inverse)
      const entry = a.min(b)
      const exit = a.max(b)
      const near = entry.x.max(entry.y).max(entry.z).max(0.001)
      const far = exit.x.min(exit.y).min(exit.z).min(0.999)
      visible.mulAssign(near.lessThan(far).select(0, 1))
    }
    return visible
  })()
  const ambient = faces.mul(mix(0.11, 0.18, clamp(positionLocal.y.add(0.3), 0, 1)))
  const lit = ambient.add(
    faces
      .mul(vec3(1.6, 1.05, 0.48))
      .mul(illumination)
      .mul(visibility),
  )
  // Compress bright nearby faces without clipping the firefly's warm colour to white.
  material.colorNode = lit.div(lit.add(0.85))
  material.toneMapped = false
  const cubes = new InstancedMesh(geometry, material, CUBE_CENTERS.length)
  cubes.frustumCulled = false
  group.add(cubes)
  // A camera-facing core and soft halo need no post-processing or extra light pipeline.
  const glowGeometry = new PlaneGeometry(0.22, 0.22)
  const glowMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false })
  const glowPoint = uv().sub(0.5).mul(2)
  const radiusSquared = glowPoint.dot(glowPoint)
  const core = float(1).sub(smoothstep(0, 0.06, radiusSquared))
  glowMaterial.colorNode = mix(vec3(1, 0.58, 0.2), vec3(1, 0.94, 0.76), core)
  glowMaterial.opacityNode = core
    .add(
      exp(radiusSquared.mul(-6))
        .mul(0.42)
        .mul(float(1).sub(smoothstep(0.5, 1, radiusSquared))),
    )
    .clamp(0, 1)
  glowMaterial.toneMapped = false
  const firefly = new Mesh(glowGeometry, glowMaterial)
  firefly.renderOrder = 1
  scene.add(firefly)
  group.updateMatrixWorld(true)
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  const lifetime = new AbortController()
  let frame = 0
  let stopped = false
  const start = performance.now()
  const animate = () => !motion.matches && !document.hidden
  const resize = () => {
    runtime.resize()
    const scale = 52
    camera.left = -innerWidth / (2 * scale)
    camera.right = -camera.left
    camera.top = innerHeight / (2 * scale)
    camera.bottom = -camera.top
    camera.updateProjectionMatrix()
  }
  const draw = (now: number) => {
    frame = 0
    if (stopped || signal.aborted) return
    movement.value = motion.matches ? 0 : 1
    time.value = (((now - start) / 1000) % CYCLE_DURATION) * ((Math.PI * 2) / CYCLE_DURATION)
    const phase = motion.matches ? 0.65 : time.value
    lightPosition.value.set(
      Math.sin(phase) * 0.98,
      0.48 + Math.cos(phase * 2) * 0.18,
      0.28 + Math.sin(phase * 2) * 0.18,
    )
    firefly.position.copy(lightPosition.value).applyMatrix4(group.matrixWorld)
    runtime.renderer.setRenderTarget(null)
    runtime.renderer.setClearColor(0x080a0d)
    runtime.renderer.render(scene, camera)
    if (animate()) frame = requestAnimationFrame(draw)
  }
  const update = () => {
    cancelAnimationFrame(frame)
    draw(performance.now())
  }
  const dispose = () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(frame)
    lifetime.abort()
    cubes.dispose()
    geometry.dispose()
    material.dispose()
    glowGeometry.dispose()
    glowMaterial.dispose()
  }
  signal.addEventListener('abort', dispose, { once: true, signal: lifetime.signal })
  try {
    resize()
    await runtime.renderer.compileAsync(scene, camera)
    signal.throwIfAborted()
    const presentationFrame = (render: boolean) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => {
          cancelAnimationFrame(presented)
          reject(new DOMException('Loader cancelled', 'AbortError'))
        }
        const presented = requestAnimationFrame(() => {
          signal.removeEventListener('abort', abort)
          if (render) draw(performance.now())
          resolve()
        })
        signal.addEventListener('abort', abort, { once: true })
      })
    // Draw inside one frame and wait for the next presentation boundary.
    await presentationFrame(true)
    signal.throwIfAborted()
    await presentationFrame(false)
    signal.throwIfAborted()
    performance.mark('loader-presented')
    runtime.canvas.dataset.loaderRendered = 'true'
    document.documentElement.dataset.loaderRendered = 'true'
    document.addEventListener('visibilitychange', update, { signal: lifetime.signal })
    motion.addEventListener('change', update, { signal: lifetime.signal })
    window.addEventListener(
      'resize',
      () => {
        resize()
        update()
      },
      { signal: lifetime.signal },
    )
    return { dispose }
  } catch (error) {
    dispose()
    throw error
  }
}
