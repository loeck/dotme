# Scene performance

The production renderer remains WebGL. Effects, DPR caps, shadow lights and map sizes,
water/bed resolutions, the 60 Hz physical clock and `?seed=` are preserved.

After integration of `feat/sun-light`, `feat/rain` and `feat/bundle-size`, the scene also
includes the solar cycle and rain, and starts from the static TypeScript lifecycle.
The measurements below predate these integrations and do not measure the combined scene.

## Implementation

- Terrain uses static indexed meshes per material and original 12-unit spatial batch.
  A BVH identifies neighbors; rectangle subtraction removes a face only when neighboring
  solids cover it completely. Partial faces are retained. A `1e-5` world-unit tolerance
  accounts for Float32 instance translations at nominal grid contacts. Albedo stays linear
  Float32; axis normals use exact normalized Int8 values. Indices use Uint16 where possible.
  Static world matrices are reused by all cameras, including shadows and reflections.
  Shadow passes retain the original cubes in smaller, 6-unit spatial batches in a shadow-only group:
  the back-face depth of internal faces affects lamp visibility. Removing them caused a
  small but visible light leak in deterministic comparisons. The group is exposed only
  during shadow rendering; color, environment and reflection passes use the culled meshes.
- The same BVH finds the nearest front-facing cube for cursor illumination and resolves
  rain segments, including starts inside solids and exclusion of submerged obstacles. Move events
  only update the latest pending sample; pointer-down remains immediate. The canvas bounds
  are shared within a frame, and height readback remains asynchronous.
- `VoxelLandscapeEngine.create(options, signal)` prepares terrain, bathymetry, mesh buffers,
  the BVH and cloud noise in a module Worker. All typed buffers transfer ownership. Completion,
  errors and unmount cancellation terminate the Worker. The synchronous constructor remains
  available for isolated harnesses and the no-Worker fallback.
- RG16F is selected only after checking framebuffer completeness, native RG/half-float
  readback and additive blending on a 1-pixel probe. Otherwise RGBA16F is retained; without
  float color attachments, the existing analytic fallback applies. Impulses share one
  instanced draw per physical update. The twelve analytic components retain their equations;
  components with an exactly zero spatial filter skip evaluation.
- Clouds use three radiance cubemaps and three shadow-atlas tiles. Seven work units prepare
  the future capture across frames. Only complete timestamps are published. Initialization,
  backwards seeks and skipped ticks rebuild immediately; a late frame finishes outstanding
  work before swapping. This smooths scheduling without lowering sample counts or total work.
- Cloud density rejects vertically excluded volumes before periodic projection. The tighter
  squared-radius bound of 2.65 follows from the maximum noise contribution: mass cannot exceed
  the `smoothstep` lower edge outside it.

Removing hidden faces trades instance-buffer reuse for fewer submitted triangles. Across
seeds 0, 12 and 9182, the new terrain retains about 61.5% of desktop faces and 56–57% of mobile
faces in color passes. Shadow topology is unchanged; smaller shadow batches
allow point-light cameras to reject more off-screen cubes. Static mesh storage is larger than the original instance buffers. The third cloud
capture adds about 3 MiB desktop / 0.75 MiB mobile, plus 0.5625 MiB for the 384² shadow tile introduced by solar lighting.

## Diagnostics and reproducible comparison

Pass `{ diagnostics: true }` to the engine in an internal harness, then call
`engine.getDiagnostics()`. The bounded history contains frame intervals, CPU submission
cost, draw calls, triangles, pass executions, live geometry/texture/program counts, and GPU
milliseconds when the extension is available. Resource counts describe live GPU resources,
not exact driver memory usage or JavaScript allocation tracing.

GPU queries are asynchronous and split at nested pass boundaries so they never overlap.
Shadow, environment, PMREM, cloud, simulation, lake-bed, reflection, main, atmosphere, rain overlay and depth-focus
costs are exclusive. A disjoint event, unavailable extension or query-budget overflow makes
the affected GPU result null. CPU timing is not GPU time. Enabling diagnostics adds overhead;
the timing benchmark disables it and records pass diagnostics separately for captures.
On macOS/Linux it waits up to two minutes for other automated browsers to finish before each
run, and flags runs with concurrent browsers. This detects a common source of contention,
not all possible GPU load from other applications.

```sh
pnpm check
pnpm e2e
pnpm benchmark:scene <reference-commit>
```

The benchmark builds production bundles of the reference and working-tree engine without
changing either tree. It alternates A/B order, uses five seconds of warm-up and thirty seconds
of measurement, and runs three repetitions for Chromium desktop and the WebKit iPhone profile.
Captures use deterministic time 18 and seeds 0, 12, 9182. JSON samples, reports and PNGs are
written to `artifacts/performance/`. The scene is isolated from the page interface for timing; application
startup and Worker integration are covered by the browser suite.

Optional environment variables: `BENCH_PROFILES=desktop,mobile`, `BENCH_REPEATS=3`,
`BENCH_SECONDS=30`, `BENCH_OUTPUT=...`, `BENCH_CAPTURE_ONLY=1`.
To evaluate the bed independently, use `BENCH_BED_EXPERIMENT=1` and a separate output directory.
It compares the optimized engine with a stride-two index grid, retaining all depth textures,
vertices at original sample centers, outer bounds and vertex attributes. This experimental
index change is confined to the harness; production retains the full bed geometry.

## WebGPU experiment

`src/scene/experimental/webgpu-water.ts` is deliberately excluded from the production import
path. Its WebGPU compute kernels use resident RGBA16F storage textures, the same nine-point
stencil, damping, wall forcing, fixed clock and twelve-component spectrum. RG16F is not a
core WebGPU storage format. A TSL preview material consumes the resident state directly for
height and normals. No state travels through the CPU into the WebGL renderer.

The browser test compares actual compute results with optimized WebGL for an impulse,
shore barrier, wind forcing and reset, then compiles/renders the TSL preview. It skips explicitly
when no WebGPU adapter exists. The preview does not yet reproduce the lake's complete optical
shader, planar reflection, cloud lighting or depth of field. Extending that port and choosing a
production migration require a complete-scene comparison: at least 20% lower p95 at equivalent
appearance on the reference devices. Compute-only results cannot justify that decision.

References: [Three.js WebGPU migration](https://threejs.org/manual/pages/webgpurenderer),
[storage textures](https://threejs.org/docs/pages/StorageTexture.html),
[Khronos asynchronous GPU timers](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/).

## Validation limits

The browser suite covers gestures, cursor lighting, parallax, resize/cancellation, reduced
motion, hidden-tab behavior, the analytic fallback, cloud continuity, shadow projection and
repeated mount/dispose cycles. Unit tests cover conservative face coverage, BVH picking against
Three.js instanced raycasting, transferred data, Worker cancellation and non-overlapping timers.

WebKit's mobile profile runs on the Mac GPU. It is not an iPhone or Android measurement. A
physical iPhone and midrange Android remain required before claiming a sustained 16.7 ms frame
budget. No automatic quality reduction or production WebGPU switch is introduced.

## Results — 2026-09-24

Reference: `aa86158` (`feat/procedural-microvoxel-lake`, local and fetched remote).
Apple M4 Pro, 48 GiB, macOS 26.7. Chromium uses ANGLE Metal at 1280 × 720;
WebKit uses the iPhone 13 profile with a 585 × 996 effective render buffer.
All figures below concern the isolated production-bundled scene, seed 9182.

| Metric                                   | Desktop reference → optimized | Mobile profile reference → optimized |
| ---------------------------------------- | ----------------------------- | ------------------------------------ |
| Submitted triangles/frame, approximately | 7.19 M → 4.54 M (−37%)        | 3.35 M → 1.94 M (−42%)               |
| Draw calls/frame, approximately          | 1,082 → 1,443                 | 674 → 874                            |
| Median CPU submission                    | 1.8–1.9 ms → 2.6 ms           | 1 ms → 1 ms                          |
| Median frame interval, unflagged runs    | 50 ms → 33.4 ms               | 16 ms → 16–17 ms                     |
| p95 frame interval, unflagged runs       | 66.7 ms → 50.1–66.6 ms        | 26–28 ms → 26–30 ms                  |

Three alternating repetitions per variant/profile were completed, each with five seconds of
warm-up and thirty seconds of samples. Four of twelve runs detected concurrent automated
browsers and are excluded from the interval ranges above. That leaves two unflagged runs per
variant/profile. The table does **not** establish a stable p95 improvement or mobile speedup:
the machine was shared, variance remains substantial, and detection cannot identify every
source of GPU contention. Desktop still misses the 16.7 ms target. Smaller shadow batches
reduce geometry at the cost of more draws and higher desktop CPU submission; physical-device
profiling must assess this tradeoff before claiming 60 fps.

At deterministic time 18, across seeds 0, 12 and 9182, mean absolute RGB differences from the
reference were 0.0011–0.0018 byte levels desktop and 0.0033–0.0038 mobile. At most 0.028% of
pixels differ by more than three byte levels. Inspection caught a visible shadow leak in the
initial all-pass face-removal variant; retaining original shadow faces removed it. These are
sampled comparisons, not a claim of bit-for-bit equivalence at every time and viewpoint.
Both test backends passed the RG16F probe and asynchronous physics/readback tests, halving
simulation target storage (16 → 8 MiB desktop, 4 → 2 MiB mobile).

The stride-two bed experiment was rejected. It produced mean differences of 0.073–0.082 byte
levels desktop and 0.186–0.256 mobile, with up to 1.88% of mobile pixels differing by more than
three levels. The full-resolution bed remains enabled; this candidate was not advanced to
refracted-intersection validation.

The WebGPU physics prototype's maximum sampled height/velocity error against WebGL was
0.000183 for an impulse and 0.000031 for wind forcing after sixty fixed steps. The barrier
remained closed and reset returned zero energy. These correctness results do not establish
a complete-scene WebGPU performance gain or justify a production migration.

Reproducible raw outputs are written by the benchmark to `artifacts/performance/report.json`
and per-run JSON/PNGs; the separate bed study uses `artifacts/bed-experiment/`. Artifacts are
ignored by Git. `pnpm check` and the browser suite cover the implementation; actual phones
and an uncontended machine remain validation requirements.
