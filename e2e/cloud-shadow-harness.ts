import {
  AmbientLight,
  BoxGeometry,
  DataUtils,
  DirectionalLight,
  HalfFloatType,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three'

import { CLOUD_DENSITY_GLSL, createCloudBodies } from '../src/scene/cloud-density'
import { createCloudNoise } from '../src/scene/cloud-noise'
import { CLOUD_SHADOW_GLSL } from '../src/scene/cloud-shadows'
import { sampleMoonLight } from '../src/scene/moon-light'
import { VolumetricClouds } from '../src/scene/volumetric-clouds'
import { WindModel } from '../src/scene/wind'

export async function exerciseCloudShadows(mobile: boolean) {
  const renderer = new WebGLRenderer()
  const wind = new WindModel(9182)
  const clouds = new VolumetricClouds(renderer, 9182, mobile, wind)
  const noise = createCloudNoise(9182)
  const direction = sampleMoonLight(0).offset.normalize()
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const geometry = new PlaneGeometry(2, 2)
  const target = new WebGLRenderTarget(32, 32, { type: HalfFloatType, depthBuffer: false })
  const material = new ShaderMaterial({
    uniforms: {
      ...clouds.shadows.uniforms,
      ...createCloudBodies(9182),
      uNoise: { value: noise },
      uDisplacement: { value: new Vector2() },
      uTime: { value: 0 },
      uProbeOffset: { value: new Vector2() },
      uDirection: { value: direction },
    },
    vertexShader:
      'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `${CLOUD_DENSITY_GLSL}\n${CLOUD_SHADOW_GLSL}
      uniform vec3 uDirection;
      uniform vec2 uProbeOffset;
      varying vec2 vUv;
      void main() {
        vec3 ground = vec3((vUv.x - 0.5) * 320.0, 0.0, vUv.y * 240.0 - 200.0);
        ground.xz += uProbeOffset;
        float length = (CLOUD_TOP - CLOUD_BASE) / (uDirection.y * 96.0);
        float depth = 0.0;
        for (int i = 0; i < 96; i++) {
          vec3 p = ground + uDirection * (CLOUD_BASE / uDirection.y + (float(i)+0.5) * length);
          depth += density(p, true) * length * CLOUD_EXTINCTION;
        }
        float reference = mix(1.0, exp(-depth), uCloudShadowStrength);
        // Raising a receiver along this light ray must preserve its shadow.
        float elevated = cloudShadow(ground + uDirection * (18.0 / uDirection.y));
        gl_FragColor = vec4(cloudShadow(ground), reference, elevated, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  })
  scene.add(new Mesh(geometry, material))
  const capture = async (time: number, followWind = false) => {
    renderer.setRenderTarget(null)
    clouds.update(time)
    material.uniforms.uProbeOffset!.value.fromArray(
      followWind ? wind.sample(time).displacement : [0, 0],
    )
    material.uniforms.uDisplacement!.value.fromArray(wind.sample(time).displacement)
    material.uniforms.uTime!.value = time
    material.uniforms.uDirection!.value.copy(sampleMoonLight(time).offset).normalize()
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    const pixels = new Uint16Array(32 * 32 * 4)
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 32, 32, pixels)
    return Array.from(pixels, DataUtils.fromHalfFloat)
  }
  const first = await capture(0)
  const midpoint = await capture(0.5 / clouds.profile.hz)
  const next = await capture(1 / clouds.profile.hz)
  const later = await capture(18)
  const following = await capture(18, true)
  const repeated = await capture(0)
  let referenceError = 0,
    heightError = 0,
    motion = 0,
    relativeMotion = 0,
    interpolationError = 0,
    repeatError = 0
  let min = 1,
    max = 0,
    darkestPixel = 0
  for (let i = 0; i < first.length; i += 4) {
    referenceError = Math.max(referenceError, Math.abs(first[i]! - first[i + 1]!))
    heightError = Math.max(heightError, Math.abs(first[i]! - first[i + 2]!))
    interpolationError = Math.max(
      interpolationError,
      Math.abs(midpoint[i]! - (first[i]! + next[i]!) / 2),
    )
    relativeMotion += Math.abs(following[i]! - first[i]!) / (first.length / 4)
    motion += Math.abs(later[i]! - first[i]!) / (first.length / 4)
    repeatError = Math.max(repeatError, Math.abs(repeated[i]! - first[i]!))
    if (first[i]! < min) darkestPixel = i / 4
    min = Math.min(min, first[i]!)
    max = Math.max(max, first[i]!)
  }
  material.dispose()
  geometry.dispose()
  noise.dispose()

  // Real instanced standard materials: moon diffuse/specular responds, local light
  // stays unchanged; sky fill also responds. This also catches a broken Three.js shader injection.
  const litScene = new Scene()
  const material3d = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 })
  clouds.shadows.applyTo(material3d)
  const box = new BoxGeometry(18, 2, 18)
  const cubes = new InstancedMesh(box, material3d, 16)
  // Put receivers beneath a measured cloud, independent of seed morphology.
  const centerX = (((darkestPixel % 32) + 0.5) / 32 - 0.5) * 320
  const centerZ = ((Math.floor(darkestPixel / 32) + 0.5) / 32) * 240 - 200
  const transform = new Object3D()
  for (let i = 0; i < 16; i++) {
    transform.position.set(
      centerX + ((i % 4) - 1.5) * 25,
      0,
      centerZ + (Math.floor(i / 4) - 1.5) * 25,
    )
    transform.updateMatrix()
    cubes.setMatrixAt(i, transform.matrix)
  }
  litScene.add(cubes)
  const top = new OrthographicCamera(-80, 80, 80, -80, 0.1, 200)
  top.position.set(centerX, 100, centerZ)
  top.up.set(0, 0, -1)
  top.lookAt(centerX, 0, centerZ)
  const moon = new DirectionalLight(0xffffff, 2)
  moon.position.copy(direction)
  litScene.add(moon)
  const lamp = new PointLight(0xffbb88, 5000, 300, 2)
  lamp.position.set(centerX, 30, centerZ)
  lamp.visible = false
  litScene.add(lamp)
  const ambient = new AmbientLight(0xffffff, 0.2)
  ambient.visible = false
  litScene.add(ambient)
  target.setSize(64, 64)
  const lightCapture = async (strength: number) => {
    clouds.shadows.uniforms.uCloudShadowStrength.value = strength
    renderer.setRenderTarget(target)
    renderer.render(litScene, top)
    const pixels = new Uint16Array(64 * 64 * 4)
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 64, 64, pixels)
    return Array.from(pixels, DataUtils.fromHalfFloat)
  }
  const moonClear = await lightCapture(0),
    moonShadow = await lightCapture(0.95)
  moon.visible = false
  lamp.visible = true
  const localClear = await lightCapture(0),
    localShadow = await lightCapture(0.95)
  lamp.visible = false
  ambient.visible = true
  const ambientClear = await lightCapture(0),
    ambientShadow = await lightCapture(0.95)
  let moonDarkening = 0,
    ambientDarkening = 0,
    localDifference = 0
  for (let i = 0; i < moonClear.length; i++) {
    ambientDarkening += ambientClear[i]! - ambientShadow[i]!
    moonDarkening += moonClear[i]! - moonShadow[i]!
    localDifference = Math.max(localDifference, Math.abs(localClear[i]! - localShadow[i]!))
  }
  clouds.dispose()
  target.dispose()
  box.dispose()
  cubes.dispose()
  material3d.dispose()
  renderer.dispose()
  return {
    referenceError,
    heightError,
    interpolationError,
    repeatError,
    motion,
    relativeMotion,
    min,
    max,
    moonDarkening,
    ambientDarkening,
    localDifference,
  }
}
