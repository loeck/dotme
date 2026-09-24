// Five cubes, one static buffer and one draw call. No Three.js, textures or lighting passes.
export const VOXEL_LOADER_REST_TIME = 2.6

export function createVoxelLoaderRenderer(canvas: HTMLCanvasElement | OffscreenCanvas) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  }) as WebGLRenderingContext | null
  if (!gl) throw new Error('Loader WebGL unavailable')

  const vertex = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(
    vertex,
    `attribute vec3 position;
     attribute float shade;
     attribute float cube;
     uniform float time;
     varying vec3 color;
     float ease(float t) {
       return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
     }
     void main() {
       // Set the foundation from the center out, then place the two outer cubes on top.
       float phase = mod(time, 5.2);
       float distance = abs(cube - 2.0);
       float upper = step(1.5, distance);
       float side = sign(cube - 2.0);
       float rank = distance < 0.5 ? 0.0 : (distance < 1.5 ? 1.0 : 3.0) + step(2.5, cube);
       float start = 0.12 + rank * 0.24 + upper * 0.2;
       float arrival = clamp((phase - start) / 0.68, 0.0, 1.0);
       float departure = clamp((phase - 3.2 - (4.0 - rank) * 0.18) / 0.68, 0.0, 1.0);
       float arriving = ease(arrival);
       float departing = ease(departure);
       float assembled = arriving * (1.0 - departing);
       vec3 home = vec3((cube - 2.0) * 0.41, -0.19, 0.0);
       // Both resting silhouettes share their horizontal and vertical midpoint.
       vec3 target = vec3(side * mix(0.318, 0.159, upper), -0.349 + upper * 0.318, 0.0);
       vec3 center = mix(home, target, assembled);
       float arc = mix(0.18, 0.52, upper);
       float flight = sin(arriving * 3.14159265) - sin(departing * 3.14159265);
       center.y += (sin(arriving * 3.14159265) + sin(departing * 3.14159265)) * arc;
       // A small, soft rebound after contact; no penetration into the supporting cubes.
       float settle = ease(clamp((phase - start - 0.68) / 0.22, 0.0, 1.0));
       center.y += sin(settle * 3.14159265) * 0.018 * (1.0 - departing);
       float tilt = side * flight * 0.09;
       vec3 local = vec3(position.x * cos(tilt) - position.y * sin(tilt),
                         position.x * sin(tilt) + position.y * cos(tilt), position.z);
       vec3 p = local + center;
       float x = p.x * 0.85 - p.z * 0.527;
       float z = p.x * 0.527 + p.z * 0.85;
       float y = p.y * 0.887 - z * 0.462;
       float depth = p.y * 0.462 + z * 0.887;
       gl_Position = vec4(x / 1.7, y / 0.945, -depth / 5.0, 1.0);
       color = vec3(0.69, 0.79, 0.85) * shade;
     }`,
  )
  gl.compileShader(vertex)
  const fragment = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(
    fragment,
    'precision mediump float; varying vec3 color; void main() { gl_FragColor = vec4(color, 1.0); }',
  )
  gl.compileShader(fragment)
  const program = gl.createProgram()!
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    throw new Error('Loader shaders unavailable')
  }
  gl.useProgram(program)

  const h = 0.15
  const corners = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ]
  const faces = [
    [0, 1, 2, 3, 0.62],
    [4, 7, 6, 5, 0.88],
    [0, 4, 5, 1, 0.7],
    [3, 2, 6, 7, 1],
    [1, 5, 6, 2, 0.8],
    [0, 3, 7, 4, 0.55],
  ]
  const vertices: number[] = []
  for (let cube = 0; cube < 5; cube++) {
    for (const face of faces) {
      for (const index of [0, 1, 2, 0, 2, 3]) {
        vertices.push(...corners[face[index]!]!, face[4]!, cube)
      }
    }
  }
  const buffer = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW)
  for (const [name, size, offset] of [
    ['position', 3, 0],
    ['shade', 1, 12],
    ['cube', 1, 16],
  ] as const) {
    const location = gl.getAttribLocation(program, name)
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 20, offset)
  }
  const time = gl.getUniformLocation(program, 'time')
  gl.enable(gl.DEPTH_TEST)
  gl.clearColor(0, 0, 0, 0)
  gl.viewport(0, 0, canvas.width, canvas.height)

  return {
    render(seconds: number) {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.uniform1f(time, seconds)
      gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 5)
      // The worker uses a 30 Hz timer, so it has no animation-frame flush boundary.
      gl.flush()
    },
    dispose() {
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
