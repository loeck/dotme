# Rendering architecture

The static document fixes the background and full-screen canvas before JavaScript.
A lightweight TSL material renders the loader using the initialized WebGPURenderer.
World preparation and the weather request start before the GPU device, so the workers (or the
world cache) and the Open-Meteo request run while the device and the loader start. Landscape
imports begin after the loader's first frame. No minimum loading duration is imposed; reduced
motion uses a static GPU image.

The profile (name, tagline and links) is in the document and the accessibility tree from the
first paint. While the scene loads it is transparent; it fades in when the scene is ready or
fails (at the latest at the 45-second deadline), or as soon as it holds keyboard
focus (immediately with reduced motion). `main` is `aria-busy` while the scene loads; the
bootstrap sets it from script, so a page without JavaScript is never left busy.

The landscape shares the renderer and canvas. It prepares its materials asynchronously
and presents its first complete frame before releasing the loader. Preparation runs in
order: world data on three workers (Rapier's WebAssembly, requested with the world, compiles
off the main thread meanwhile; [loading](performance.md#loading)), collider
creation, a loader frame, scene construction, then one compilation sequence and a warmup
render; [verification](performance.md#loading) describes the batch. Failure handling
belongs to the page lifecycle: a single 45-second deadline in the inline HTML bootstrap marks
the scene failed and dispatches `scene-timeout`, which cancels initialization in `src/main.ts`;
being independent of the module, it releases the profile even when the primary module fails.

The scene separates CPU world generation, GPU resources, simulation and composition.
Node materials and TSL passes render through WebGPU. Without a working WebGPU adapter or
device, the same renderer is created with its WebGL 2 backend, and the same TSL graph is
compiled to GLSL; the page releases its static profile only when WebGL 2 is unavailable too.
Device or context loss ends the graphics session and releases the profile. The scene renders its view at a dynamic share of the drawing buffer, which the lens upsamples
([dynamic resolution](performance.md#dynamic-resolution)). The water solver alternates two render targets; the CPU supplies bounded interactions, clock and weather
state. Rapier owns collision queries and stepped rigid-body dynamics over the terrain
colliders; analytic GPU flows and the wave solver stay custom. World generation is
deterministic in its seed and layout, so three instances of the world worker each compose
the lake again (`lake-world.ts`) and prepare disjoint parts in parallel: one builds the smooth terrain
mesh and its boulders ([terrain](terrain.md)), one prepares lake-bed geometry and normals,
water geometry, the half-float depth/shore atlas, the simulation mask, cloud noise and the
static colliders (a heightfield and boulder hulls), and one grows the forest. Each worker first
looks its part up in the world cache ([loading](performance.md#loading)). The forest is a separate message:
the world resolves without it, so physics and scene construction start sooner, and the
engine adds and compiles it before the first frame (see [vegetation](vegetation.md#loading)). Every part transfers typed buffers; the render thread combines
them and wraps those buffers in GPU resources and Rapier colliders without repeating
array generation or bounds scans. Audio has its own asynchronous resource
lifetime.

The terrain and the boulders are each one static mesh with one material, and their shadow
casters share their geometry. Environment materials are compiled once with all meshes
included; the six cubemap views reuse those programs with normal culling restored.

Both backends must produce the same image. Three normalizes texture and screen
coordinates, but three conventions remain the scene’s responsibility:
`src/scene/backend-nodes.ts` converts sampled depth to clip-space Z before unprojection
(`clipDepth`) and clip-space Z to a written fragment depth (`fragmentDepth`), and
provides screen-linear varyings because GLSL ES 3.00 has no `noperspective`. CPU
readbacks of render targets arrive bottom-up on WebGL. When changing these conventions,
compare both backends on fixed scenes with `?backend=webgl` and the benchmark captures.

## Module map

`src/main.ts` boots the page: the loader (`components/scene-loader.ts`), the world and weather
preloads (`components/scene-world.ts`, `weather/`), then `components/landscape.ts`, which owns
the renderer, the sound and the live weather and drives `LandscapeEngine`. Browser guards shared
by the page and the scene (`storage()` for localStorage, the reduced-motion query) live in
`src/env.ts`.

`src/scene/landscape-engine.ts` is the coordinator: `LandscapeEngine.create` prepares the world,
builds the scene and runs the compile sequence; each frame `render` advances the clock, light and
weather, hands the frame to the subsystems below in a fixed order and then runs the passes. The
engine shares its frame state (scene clock, intro fade, reduced motion, daylight, focus) with
them by reference (`landscape-state.ts`). Its parts, each with a narrow constructor interface:

| Module                  | Role                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `scene-setup.ts`        | One-time construction: terrain meshes and their shadow casters, the sky light, mounting the lake surface, lit-scene layers |
| `scene-compile.ts`      | The compile sequence (offscreen passes, probe, shadow maps, views, mirror) and the warmup render                           |
| `scene-picking.ts`      | The pointer ray against water, colliders and crowns; resting points and sound placement on the water                       |
| `landscape-input.ts`    | Pointer, touch and wheel gestures: stirring, waves, stone throws, lanterns, grabbing floaters, the time scrub              |
| `cursor-effects.ts`     | What pointing does: the night pointer light, the waterfall block, parting clouds, the rain umbrella                        |
| `lantern-system.ts`     | The floating lanterns (bulbs, glows, point lights, cube-shadow refresh) and the night motes                                |
| `environment-probe.ts`  | The live environment cube (one face per interval, PMREM per sweep) and the lake's sky reflection                           |
| `frame-passes.ts`       | The frame's GPU passes in order, measured for the benchmark                                                                |
| `frame-scheduler.ts`    | Frame pacing in the foreground, the background and under reduced motion                                                    |
| `weather-view.ts`       | Draws the blended weather (`weather-state.ts`): clouds, rain, snow, fog and the rainbow                                    |
| `landscape-wildlife.ts` | Birds (`flock-schedule.ts`), falling leaves and insects                                                                    |
| `sky-dome.ts`           | The sky dome, its reflected copy and the shooting stars                                                                    |
| `sun-flare.ts`          | The sun's lens flare and its occlusion                                                                                     |
| `ambient-report.ts`     | The ambient sound's environment report, four times a second                                                                |
| `scene-hooks.ts`        | The benchmark hooks on `window` (GPU counters, pass capture, group elimination)                                            |

Shared helpers: `math.ts` (`clamp`, `saturate`, `mix`, `smoothstep`), `hash.ts` (the seeded
lattice hash of world generation) and `shader-noise.ts` (the TSL sine hash). World generation is
deterministic per seed, so these keep the exact operation order of the copies they replaced;
`math.test.ts` pins their outputs. `box-index.ts` is the axis-aligned box BVH of simple fixtures
and the box colliders.

## Type checking

`tsconfig.json` covers application, unit tests, browser harnesses, scripts and configuration.
It uses ES2023, Preserve/Bundler modules, erasable syntax, explicit type imports, strict
optional properties, indexed access, unused declarations, returns and side-effect imports.
Oxlint runs with type information and forbids casts, non-null assertions, explicit `any`
and TypeScript error suppressions. The local `type-policy/no-definite-assignment` rule
also rejects declaration assertions such as uninitialized variables and class fields marked
with `!`; native postfix-assertion rules do not cover those AST forms. `pnpm lint` performs
this audit across source, browser harnesses, scripts and configuration and fails on any
warning (`--deny-warnings`); a disabled rule needs a justification. `pnpm knip` reports unused
files, exports and dependencies (`knip.json` lists the worker, the browser harnesses and the
scripts as entries). `pnpm check` runs both before tests, build and the compressed-size budget
check.

Declaration files are type-checked too (no `skipLibCheck`), against `@types/node@26.6.6`
for the Node 26 runtime.
