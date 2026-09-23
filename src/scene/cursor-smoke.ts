import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from 'three'

/** A tiny transparent surface: the smoke deforms locally instead of rotating as an image. */
export function createCursorSmoke(canvas: HTMLCanvasElement) {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, depth: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  // Padding lets the vapor dissolve well before it reaches the canvas edges.
  renderer.setSize(96, 96, false)
  renderer.setClearColor(0x000000, 0)
  const geometry = new PlaneGeometry(2, 2)
  const timeUniform = { value: 0 }
  const material = new ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { uTime: timeUniform },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), u.x), u.y);
      }
      float fbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 4; i++) {
          value += amplitude * noise(p);
          p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.03 + 7.1;
          amplitude *= 0.5;
        }
        return value;
      }
      void main() {
        // Keep the noise scale in CSS pixels, independent of the padded canvas.
        vec2 p = (vUv - 0.5) * 96.0 / 20.0;
        float radius = length(p);
        float vapor = 0.0;
        // Thin veils sink independently from the lower rim. Limit sideways growth
        // and thin them as they stretch, so aging releases never become dense blobs.
        for (int i = 0; i < 3; i++) {
          float id = float(i);
          float clock = uTime / (8.7 + id * 1.9) + 0.22 + id * 0.29;
          float cycle = floor(clock);
          float age = fract(clock);
          float seed = hash(vec2(cycle + 3.0, id + 7.0));
          float angle = -2.35 + id * 0.76 + (seed - 0.5) * 0.32;
          vec2 source = vec2(cos(angle), sin(angle)) * 0.68;
          vec2 drift = vec2((seed - 0.5) * 0.30, -0.55) * age;
          vec2 size = vec2(0.095, 0.21) + vec2(0.035, 0.12) * age;
          vec2 local = (p - source - drift) / size;
          vec2 flow = p * 1.8 + vec2(id * 4.7, uTime * 0.08);
          vec2 curl = vec2(fbm(flow), fbm(flow + 5.3)) - 0.5;
          local += curl * 0.65;
          local.x += sin(local.y * 1.4 + id + uTime * 0.25) * 0.24;
          float cloud = exp(-dot(local, local) * 1.3);
          float texture = 0.4 + 0.6 * fbm(flow + curl);
          float lifetime = smoothstep(0.0, 0.18, age)
                         * (1.0 - smoothstep(0.35, 1.0, age));
          // Some releases are barely perceptible, leaving natural quiet intervals.
          float release = smoothstep(0.16, 0.78, seed);
          float thinning = 1.0 / (1.0 + age * 1.5);
          // Overlapping veils must not accumulate into a bright patch.
          vapor = max(vapor, cloud * texture * lifetime * release * thinning);
        }
        // Keep the interior clear and dissolve well within the padded surface.
        float envelope = smoothstep(0.65, 0.73, radius)
                       * (1.0 - smoothstep(1.45, 1.95, radius));
        float alpha = 0.085 * (1.0 - exp(-vapor * 2.0)) * envelope;
        gl_FragColor = vec4(vec3(0.60, 0.74, 0.86), alpha);
      }
    `,
  })
  const scene = new Scene()
  scene.add(new Mesh(geometry, material))
  const camera = new OrthographicCamera()
  return {
    render(time: number) {
      timeUniform.value = time
      renderer.render(scene, camera)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
}
