# Rendering architecture

The static document fixes the background and full-screen canvas before JavaScript.
A lightweight TSL material renders the loader using the initialized WebGPURenderer.
Landscape imports begin after the loader's first frame. World preparation and weather
can then proceed in parallel while the loader continues rendering. No minimum loading
duration is imposed; reduced motion uses a static GPU image.

The landscape shares the renderer and canvas. It prepares its materials asynchronously
and presents its first complete frame before releasing the loader. Failure handling
belongs to the page lifecycle: initialization is cancelled after 20 seconds, and an
independent HTML deadline releases the profile even when the primary module fails.

The scene separates CPU world generation, GPU resources, simulation and composition.
Node materials and TSL passes render through WebGPU. Without a working WebGPU adapter,
the page releases its static profile. Device loss ends the graphics session and releases
the profile. The water solver alternates two render targets; the CPU supplies bounded interactions, clock and weather
state. The world worker prepares terrain, shadow bounds, lake-bed geometry and normals,
water geometry, the half-float depth/shore atlas and the simulation mask. It transfers
typed buffers; the render thread wraps those buffers in GPU resources without repeating
array generation or bounds scans. Audio has its own asynchronous resource lifetime.

Shadow batches carry their transforms as instanced vertex attributes, sharing shader
programs across batch sizes. Environment materials are compiled once with all meshes
included; the six cubemap views reuse those programs with normal culling restored.

Diagnostics consume public renderer counters through a minimal interface. CPU submission
costs are distinct from GPU execution time. Unavailable GPU timings remain null. Snapshot
consumers never need private renderer or engine fields.

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
