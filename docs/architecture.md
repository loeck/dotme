# Rendering architecture

The static document fixes the background and full-screen canvas before JavaScript.
A lightweight TSL material renders the loader using the initialized WebGPURenderer.
Landscape imports begin after the loader's first frame. World preparation and weather
can then proceed in parallel while the loader continues rendering. No minimum loading
duration is imposed; reduced motion uses a static GPU image.

The landscape shares the renderer and canvas. It prepares its materials asynchronously
and presents its first complete frame before releasing the loader. Preparation runs in
order: world data on two workers (Rapier loads and initializes meanwhile), collider
creation, a loader frame, scene construction, then one compilation batch and a warmup
render; [verification](performance.md#loading) describes the batch. Failure handling
belongs to the page lifecycle: initialization is cancelled after 20 seconds, and an
independent HTML deadline releases the profile even when the primary module fails.

The scene separates CPU world generation, GPU resources, simulation and composition.
Node materials and TSL passes render through WebGPU. Without a working WebGPU adapter or
device, the same renderer is created with its WebGL 2 backend, and the same TSL graph is
compiled to GLSL; the page releases its static profile only when WebGL 2 is unavailable too.
Device or context loss ends the graphics session and releases the profile. The water solver alternates two render targets; the CPU supplies bounded interactions, clock and weather
state. Rapier owns collision queries and stepped rigid-body dynamics over the terrain
colliders; analytic GPU flows and the wave solver stay custom. World generation is
deterministic in its seed and layout, so two instances of the world worker each compose
the lake again (`lake-world.ts`) and prepare disjoint halves in parallel: one builds the smooth terrain
mesh and its boulders ([terrain](terrain.md)), the other prepares lake-bed geometry and normals,
water geometry, the half-float depth/shore atlas, the simulation mask, cloud noise and the
static colliders (a heightfield and boulder hulls), and then grows the forest. The forest is a separate message:
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
readbacks of render targets arrive bottom-up on WebGL. `pnpm e2e:gpu` compares both
backends pixel by pixel on fixed scenes.

## Type checking

`tsconfig.json` covers application, unit tests, browser harnesses, scripts and configuration.
It uses ES2023, Preserve/Bundler modules, erasable syntax, explicit type imports, strict
optional properties, indexed access, unused declarations, returns and side-effect imports.
Oxlint runs with type information and forbids casts, non-null assertions, explicit `any`
and TypeScript error suppressions. The local `type-policy/no-definite-assignment` rule
also rejects declaration assertions such as uninitialized variables and class fields marked
with `!`; native postfix-assertion rules do not cover those AST forms. `pnpm lint` performs
this audit across source, browser harnesses, scripts and configuration, and `pnpm check`
runs it before tests, build and the compressed-size budget check.

`skipLibCheck` is temporarily retained for `happy-dom@20.14.5`: its
`BrowserWindow.d.ts` references `node:stream/web.UnderlyingDefaultSource`, which is absent
from `@types/node@24.13.6`. Re-run `pnpm exec tsc --noEmit --skipLibCheck false` after
upgrading those declarations; remove the exemption once that external incompatibility is fixed.
