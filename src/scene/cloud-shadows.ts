import {
  LinearFilter,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderChunk,
  ShaderMaterial,
  Vector3,
  WebGLRenderTarget,
} from 'three'
import type { Camera, IUniform, MeshStandardMaterial, WebGLRenderer } from 'three'

import { CLOUD_DENSITY_GLSL } from './cloud-density'
import { DISTANT_HORIZON_GLSL } from './distant-horizon'

// Orthographic light-space coverage encloses terrain and the 240-unit air volume.
export const CLOUD_SHADOW_SIZE = 768
const TILE = 384
const CENTER = new Vector3(0, 40, -120)

export function cloudShadowFrame(direction: Vector3) {
  const right = new Vector3(direction.z, 0, -direction.x).normalize()
  if (right.lengthSq() < 0.5) right.set(1, 0, 0)
  const up = new Vector3().crossVectors(direction, right).normalize()
  const matrix = new Matrix4().set(
    right.x / CLOUD_SHADOW_SIZE,
    right.y / CLOUD_SHADOW_SIZE,
    right.z / CLOUD_SHADOW_SIZE,
    0.5 - right.dot(CENTER) / CLOUD_SHADOW_SIZE,
    up.x / CLOUD_SHADOW_SIZE,
    up.y / CLOUD_SHADOW_SIZE,
    up.z / CLOUD_SHADOW_SIZE,
    0.5 - up.dot(CENTER) / CLOUD_SHADOW_SIZE,
    direction.x,
    direction.y,
    direction.z,
    -direction.dot(CENTER),
    0,
    0,
    0,
    1,
  )
  return { matrix, right, up }
}

export const CLOUD_SHADOW_GLSL = `
${DISTANT_HORIZON_GLSL}
uniform vec3 uHorizonDirection;
uniform float uHorizonSeed;
uniform float uHorizonMobile;
uniform sampler2D uCloudShadowAtlas;
uniform float uCloudShadowPreviousOffset;
uniform float uCloudShadowNextOffset;
uniform mat4 uCloudShadowPreviousMatrix;
uniform mat4 uCloudShadowNextMatrix;
uniform float uCloudShadowBlend;
uniform float uCloudShadowStrength;
float celestialVisibility() {
  return distantLightVisibility(uHorizonDirection, uHorizonSeed, uHorizonMobile);
}
float cloudTransmission(float offset, vec2 uv) {
  float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
  // Clamp within each 384-pixel tile so linear filtering never crosses timestamps.
  uv = clamp(uv, vec2(0.5 / 384.0), vec2(1.0 - 0.5 / 384.0));
  uv.x = uv.x / 3.0 + offset;
  return mix(1.0, texture2D(uCloudShadowAtlas, uv).r, smoothstep(0.0, 0.06, edge));
}
float cloudShadowProjected(vec2 previous, vec2 next) {
  if (uCloudShadowStrength <= 0.0) return 1.0;
  float transmission = mix(
    cloudTransmission(uCloudShadowPreviousOffset, previous),
    cloudTransmission(uCloudShadowNextOffset, next), uCloudShadowBlend);
  return mix(1.0, transmission, uCloudShadowStrength);
}
float cloudShadow(vec3 world) {
  return cloudShadowProjected((uCloudShadowPreviousMatrix * vec4(world, 1.0)).xy,
    (uCloudShadowNextMatrix * vec4(world, 1.0)).xy);
}
`

/** Beer–Lambert shadow maps, captured on the exact same clock as the visible sky. */
export class CloudShadows {
  // All three capture times share one sampler, leaving room for seven lamp shadow maps
  // in the water shader on devices with the WebGL2 minimum of 16 fragment samplers.
  private readonly atlas = new WebGLRenderTarget(TILE * 3, TILE, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })
  private readonly matrices = [new Matrix4(), new Matrix4(), new Matrix4()]
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly material: ShaderMaterial
  readonly uniforms = {
    uHorizonDirection: { value: new Vector3(0, 1, 0) },
    uHorizonSeed: { value: 0 },
    uHorizonMobile: { value: 0 },
    uCloudShadowAtlas: { value: this.atlas.texture },
    uCloudShadowPreviousOffset: { value: 0 },
    uCloudShadowNextOffset: { value: 1 / 3 },
    uCloudShadowPreviousMatrix: { value: this.matrices[0]! },
    uCloudShadowNextMatrix: { value: this.matrices[1]! },
    uCloudShadowBlend: { value: 0 },
    uCloudShadowStrength: { value: 0.95 },
  }

  constructor(
    private readonly renderer: WebGLRenderer,
    volumeUniforms: Record<string, IUniform>,
    blend: IUniform<number>,
  ) {
    this.uniforms.uCloudShadowBlend = blend
    this.atlas.texture.name = 'Light-space cloud transmission atlas'
    Object.assign(volumeUniforms, {
      uShadowRight: { value: new Vector3() },
      uShadowUp: { value: new Vector3() },
    })
    this.atlas.scissorTest = true
    this.material = new ShaderMaterial({
      uniforms: volumeUniforms,
      defines: { SHADOW_STEPS: 32 },
      vertexShader:
        'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        ${CLOUD_DENSITY_GLSL}
        uniform vec3 uMoonDirection;
        uniform vec3 uShadowRight;
        uniform vec3 uShadowUp;
        varying vec2 vUv;
        void main() {
          if (uMoonDirection.y <= 0.0001) { gl_FragColor = vec4(1.0); return; }
          vec3 ground = vec3(0.0, 40.0, -120.0)
            + ((vUv.x - 0.5) * uShadowRight + (vUv.y - 0.5) * uShadowUp) * ${CLOUD_SHADOW_SIZE.toFixed(1)};
          float stepLength = min((CLOUD_TOP - CLOUD_BASE) / uMoonDirection.y, 2400.0) / float(SHADOW_STEPS);
          float entry = clamp((CLOUD_BASE - ground.y) / uMoonDirection.y, -12000.0, 12000.0);
          float opticalDepth = 0.0;
          for (int i = 0; i < SHADOW_STEPS; i++) {
            vec3 p = ground + uMoonDirection * (entry + (float(i) + 0.5) * stepLength);
            opticalDepth += density(p, true) * stepLength * CLOUD_EXTINCTION;
            if (opticalDepth > 5.0) break;
          }
          gl_FragColor = vec4(vec3(exp(-opticalDepth)), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    this.scene.add(new Mesh(this.geometry, this.material))
  }

  capture(index: number) {
    const previous = this.renderer.getRenderTarget()
    const face = this.renderer.getActiveCubeFace()
    const mip = this.renderer.getActiveMipmapLevel()
    try {
      const frame = cloudShadowFrame(this.material.uniforms.uMoonDirection!.value)
      this.matrices[index]!.copy(frame.matrix)
      this.material.uniforms.uShadowRight!.value.copy(frame.right)
      this.material.uniforms.uShadowUp!.value.copy(frame.up)
      this.atlas.viewport.set(index * TILE, 0, TILE, TILE)
      this.atlas.scissor.copy(this.atlas.viewport)
      this.renderer.setRenderTarget(this.atlas)
      this.renderer.render(this.scene, this.camera)
    } finally {
      this.renderer.setRenderTarget(previous, face, mip)
    }
  }

  select(previous: number, next: number) {
    this.uniforms.uCloudShadowPreviousOffset.value = previous / 3
    this.uniforms.uCloudShadowNextOffset.value = next / 3
    this.uniforms.uCloudShadowPreviousMatrix.value = this.matrices[previous]!
    this.uniforms.uCloudShadowNextMatrix.value = this.matrices[next]!
  }

  /** Shade moonlight and approximate local sky visibility; preserve lamps and emission. */
  applyTo(material: MeshStandardMaterial, mainCamera?: Camera) {
    const previousCompile = material.onBeforeCompile
    const previousCacheKey = material.customProgramCacheKey()
    const fog = { value: 1 }
    material.onBeforeRender = (_renderer, _scene, camera) => {
      fog.value = camera === mainCamera ? 0 : 1
    }
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile.call(material, shader, renderer)
      Object.assign(shader.uniforms, this.uniforms, { uAtmosphereFog: fog })
      shader.vertexShader =
        'varying vec3 vCloudWorldPosition;\n' +
        shader.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 cloudPosition = vec4(transformed, 1.0);
          #ifdef USE_BATCHING
            cloudPosition = batchingMatrix * cloudPosition;
          #endif
          #ifdef USE_INSTANCING
            cloudPosition = instanceMatrix * cloudPosition;
          #endif
          vCloudWorldPosition = (modelMatrix * cloudPosition).xyz;`,
        )
      shader.fragmentShader =
        `uniform float uAtmosphereFog;\nvarying vec3 vCloudWorldPosition;\n${CLOUD_SHADOW_GLSL}\n` +
        shader.fragmentShader
          .replace(
            '#include <fog_fragment>',
            'if (uAtmosphereFog > 0.5) {\n#include <fog_fragment>\n}',
          )
          .replace(
            '#include <lights_fragment_begin>',
            'float cloudVisibility = cloudShadow(vCloudWorldPosition);\n' +
              ShaderChunk.lights_fragment_begin.replace(
                'getDirectionalLightInfo( directionalLight, directLight );',
                'getDirectionalLightInfo( directionalLight, directLight );\n directLight.color *= cloudVisibility * celestialVisibility();',
              ),
          )
          .replace(
            '#include <lights_fragment_end>',
            `// Local sky fill loses illumination beneath thick cloud cover.
          // Keep direct point lights and emission outside this approximation.
          float cloudFill = mix(0.35, 1.0, cloudVisibility);
          #if defined(RE_IndirectDiffuse)
            irradiance *= cloudFill;
            iblIrradiance *= cloudFill;
          #endif
          #if defined(RE_IndirectSpecular)
            radiance *= mix(0.65, 1.0, cloudVisibility);
          #endif
          #include <lights_fragment_end>`,
          )
    }
    material.customProgramCacheKey = () => `${previousCacheKey}:moon-cloud-shadow-v2`
    material.needsUpdate = true
  }

  dispose() {
    this.atlas.dispose()
    this.material.dispose()
    this.geometry.dispose()
  }
}
