import {
  DepthTexture,
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  WebGLRenderTarget,
} from 'three'
import type { PerspectiveCamera, WebGLRenderer } from 'three'

const vertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const fragmentShader = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uCssPixel;
uniform vec2 uCameraRange;
varying vec2 vUv;

float viewDistance(vec2 uv) {
  float depth = texture2D(tDepth, uv).x;
  return uCameraRange.x * uCameraRange.y /
    (uCameraRange.y - depth * (uCameraRange.y - uCameraRange.x));
}

float circleOfConfusion(float distance) {
  // The near stones sit 5–11 units from the lens. The tree and both lamp
  // banks share a broad focus plane; only the distant valley softens again.
  float nearBlur = 9.0 * (1.0 - smoothstep(5.0, 21.0, distance));
  float farBlur = 1.35 * smoothstep(90.0, 180.0, distance);
  return max(nearBlur, farBlur);
}

void main() {
  vec3 center = texture2D(tColor, vUv).rgb;
  float centerDistance = viewDistance(vUv);
  float radius = circleOfConfusion(centerDistance);
  vec3 color = center;
  if (radius > 0.3) {
    float weight = 1.0;
    // A fixed golden-angle disc gives a stable, circular aperture. Samples
    // across a nearer focused edge are rejected so hills cannot smear trees.
    for (int i = 0; i < FOCUS_SAMPLES; i++) {
      float index = float(i) + 0.5;
      float angle = index * 2.39996323;
      float ring = sqrt(index / float(FOCUS_SAMPLES));
      vec2 offset = vec2(cos(angle), sin(angle)) * ring * radius * uCssPixel;
      vec2 uv = clamp(vUv + offset, vec2(0.0), vec2(1.0));
      float sampleDistance = viewDistance(uv);
      float foreground = 1.0 - smoothstep(14.0, 21.0, centerDistance);
      float accepted = mix(
        smoothstep(centerDistance * 0.65, centerDistance * 0.9, sampleDistance),
        1.0,
        foreground
      );
      color += texture2D(tColor, uv).rgb * accepted;
      weight += accepted;
    }
    color /= weight;
  }
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/** One scene render, its resolved depth, and one selective lens pass. */
export class DepthFocus {
  private readonly target: WebGLRenderTarget
  private readonly scene = new Scene()
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly geometry = new PlaneGeometry(2, 2)
  private readonly material: ShaderMaterial

  constructor(renderer: WebGLRenderer, mobile: boolean) {
    this.target = new WebGLRenderTarget(1, 1, {
      // Linear 8-bit storage visibly bands this nearly black sky.
      type: HalfFloatType,
      depthTexture: new DepthTexture(1, 1, UnsignedIntType),
      samples: mobile ? 0 : Math.min(2, renderer.capabilities.maxSamples),
      stencilBuffer: false,
    })
    this.target.texture.name = 'Landscape lens color'
    this.material = new ShaderMaterial({
      name: 'LandscapeDepthFocus',
      vertexShader,
      fragmentShader,
      defines: { FOCUS_SAMPLES: mobile ? 12 : 20 },
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uCssPixel: { value: new Vector2(1, 1) },
        uCameraRange: { value: new Vector2(0.05, 500) },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: true,
    })
    const quad = new Mesh(this.geometry, this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
  }

  resize(bufferWidth: number, bufferHeight: number, cssWidth: number, cssHeight: number) {
    this.target.setSize(bufferWidth, bufferHeight)
    this.material.uniforms.uCssPixel!.value.set(1 / cssWidth, 1 / cssHeight)
  }

  render(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera) {
    this.material.uniforms.uCameraRange!.value.set(camera.near, camera.far)
    const previousTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(this.target)
    // Reflector restores this target after its own camera pass.
    renderer.render(scene, camera)
    renderer.setRenderTarget(previousTarget)
    renderer.render(this.scene, this.camera)
  }

  dispose() {
    this.target.dispose()
    this.geometry.dispose()
    this.material.dispose()
  }
}
