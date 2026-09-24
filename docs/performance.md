# Scene performance

The production renderer remains WebGL. Effects, DPR caps, shadow lights and map sizes,
water/bed resolutions, the 60 Hz physical clock and `?seed=` are preserved.

After integration of `feat/sun-light`, `feat/rain` and `feat/bundle-size`, the scene also
includes the solar cycle and rain, and starts from the static TypeScript lifecycle.
The original results section predates these integrations. The combined-scene follow-up
below uses the merged commit `59eada9` as its reference.

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
Captures use deterministic scene/solar time 18 and seeds 0, 12, 9182. The combined-scene
harness also advances rain by three fixed-step seconds to include established impacts;
animation timing enables rain and the real solar clock. JSON samples, reports and PNGs are
written to `artifacts/performance/`. The scene is isolated from the page interface for timing; application
startup and Worker integration are covered by the browser suite.

Optional environment variables: `BENCH_PROFILES=desktop,mobile`, `BENCH_REPEATS=3`,
`BENCH_SECONDS=30`, `BENCH_OUTPUT=...`, `BENCH_CAPTURE_ONLY=1`, `BENCH_SEEDS=0,12,9182`,
`BENCH_QUERY='time=08:30&rain=heavy&weather=partly-cloudy'`.
The default query fixes midnight with heavy rain and partly cloudy weather.
`BENCH_DIAGNOSTICS=1` records separate per-pass histories and adds timer overhead; use it
for investigation, not the headline frame-rate comparison.
`BENCH_RAIN_CPU=1` compares 600 fixed rain steps with two wind reversals, with rendering
stopped, and records a checksum of every drop and impact field.
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

## Follow-up after merging solar lighting, rain and the static page

Reference: `59eada9`, containing all three local feature branches and the previous
performance work. The new changes retain rain density, particle pools, fixed steps,
lighting, shadow maps, air samples, post-processing and render resolutions.

- The Worker prepares conservative two-metre columns containing the highest voxel top.
  A rain segment above every crossed column cannot touch terrain and skips the BVH.
  Remaining candidates use the same exact slab intersection, including inside starts.
  Scratch ray vectors are reused, and steady wind skips only an exactly zero response.
- Every vertex of a rain streak shares its world position. Its lighting now runs in
  the vertex shader and is interpolated across the sheet, instead of repeating the
  same lamp/glint calculation at every covered pixel. Splash crowns retain spatially
  varying fragment lighting. Lights with exactly zero energy skip their calculations.
- Air integration projects each ray origin and step into the terrain and two cloud
  shadow frames once, instead of projecting all 16/32 sample positions separately.
  Sample locations and midpoint quadrature are unchanged. Fully terrain-blocked
  samples skip cloud lookups, and empty air segments return unit transmission.
- Diagnostics include `rain-update` and `rain-slopes`, alongside the atmosphere and
  rain overlay. GPU query totals on this ANGLE/Metal setup were inconsistent with
  frame pacing; this follow-up uses CPU timings and diagnostic-free frame intervals
  for conclusions rather than assigning precise GPU milliseconds to passes.

For 600 fixed steps with heavy rain, including two wind changes, three alternating
trials gave 621–634 ms before / 184–187 ms after on Chromium desktop, and 228–235 ms
before / 65–67 ms after on the WebKit mobile profile: about 70–72% less simulation
CPU time. Full drop/impact state checksums were identical for every A/B trial. This
is an isolated simulation result, not a frame-rate or physical-phone measurement.

At midnight, heavy-rain captures across seeds 0, 12 and 9182 were identical on WebKit;
Chromium mean absolute RGB differences stayed below 0.000007 byte levels, with one
pixel in seed 0 differing by five levels. At 08:30, after the air optimization, mean
differences stayed below 0.000054 byte levels and maximum differences were three
levels desktop / one mobile. These are sampled image checks, not all-time equivalence.

Full-scene trials used five seconds of warm-up and thirty seconds of sampling, three
alternating repetitions per variant/profile, with diagnostics disabled and heavy rain.
The table includes only trials without detected competing automated browsers; counts
are reference/candidate. Values are ranges of per-trial medians or p95s, not pooled samples.

| Scenario / profile               | Clean trials | Median CPU ms, before → after | Frame p95 ms, before → after |
| -------------------------------- | ------------ | ----------------------------- | ---------------------------- |
| Midnight / Chromium              | 1 / 2        | 9.5 → 4.0–4.5                 | 66.7 → 33.4–66.6             |
| Midnight / WebKit mobile profile | 2 / 2        | 2 → 2                         | 18–27 → 18                   |
| 08:30 / Chromium                 | 3 / 3        | 4.0–4.1 → 2.3–2.7             | 33.3–33.4 → 33.3–49.9        |
| 08:30 / WebKit mobile profile    | 3 / 1        | 2 → 1                         | 25–27 → 23                   |

Seven of twenty-four trials detected concurrent browsers. Detection does not capture
all system GPU load: even unflagged trials varied substantially, and one optimized
desktop morning trial had a worse p95. These data establish neither a stable overall
p95 improvement nor sustained 60 fps on desktop. WebKit CPU timings are quantized to
milliseconds; the isolated fixed-step test above is the stronger CPU comparison.
Physical-phone validation remains outstanding.

Raw reports, frame samples and captures are in `artifacts/combined-perf-night/` and
`artifacts/combined-perf-day/`; fixed-step checksums and timings are in
`artifacts/merged-rain-cpu/`. Use `59eada9` with the benchmark commands above to repeat
this comparison. The older `artifacts/performance/` report covers the pre-merge scene.

Final combined validation: `pnpm check` passes (typecheck, lint, formatting, 124 unit
tests and production build); Playwright reports 74 passed and four expected skips
(two opt-in solar baseline benchmarks, the mobile mouse cursor and mobile WebGPU).
Coverage includes the new column rejection against exact voxel intersections, rain
and wind changes, solar scattering and shadows, reduced motion, RGBA8/analytic
fallbacks, resize, page restoration, Worker cancellation and repeated disposal.

## Periodic stalls in the complete page

The isolated scene harness above has no `.profile-panel`, so it does not run the
backdrop contrast meter. A subsequent trace of the **complete page** reproduced
periodic stalls in Chromium with heavy rain, both day and night. The rain made the
pauses particularly visible, but the blocking operation was the meter's GPU readback.
Even after Three.js's asynchronous fence had signaled, `getBufferSubData` blocked
Chrome's main thread for up to 213 ms behind later queued rendering commands.

The meter now keeps the same 32 backdrop samples, exposure, Reinhard mapping,
RGBA8 quantization, one-second cadence and contrast hysteresis. Its shader discards
the pixel when the backdrop is dark, and an `ANY_SAMPLES_PASSED` query returns the
classification. Query availability is polled on later tasks; the result is read only
when ready. No pixel buffer is copied to the CPU. Comparing integer byte values
avoids a GLSL division-rounding error exactly at the 0.2 threshold. Pending queries
and timers are released on disposal and context loss, including reduced-motion pages.
See the [WebGL 2 query specification](https://registry.khronos.org/webgl/specs/2.0/#3.7.12).

A local full-page Chromium/Metal trace used seed 9182, heavy rain, partly cloudy sky,
1440 × 900 CSS pixels and device scale 2 (the existing desktop DPR cap remains 1.75).
After five seconds of warm-up, about 35 seconds were observed per scenario:

| Full page        | Frame p95 | Frame p99 | Maximum interval | Intervals above 100 ms |
| ---------------- | --------- | --------- | ---------------- | ---------------------- |
| 08:30 before     | 83.3 ms   | 150 ms    | 166.7 ms         | 35                     |
| 08:30 with query | 33.3 ms   | 33.4 ms   | 33.5 ms          | 0                      |
| 00:00 with query | 50 ms     | 66.7 ms   | 66.7 ms          | 0                      |

The corrected day and night traces made zero `getBufferSubData` calls. These are
local diagnostic runs, not three alternating production benchmarks or a guarantee
of 60 fps; the remaining frame cost, especially at night, is still measurable.
Raw traces and frame samples are in the ignored `artifacts/stutter/` directory.

Regression coverage includes full production pages at both times across Chromium
and WebKit, requiring several meter updates without GPU buffer copies. Eighty
GPU classification cases per browser cover both hysteresis thresholds, HDR values,
exposure and panel cropping; unit tests cover deferred availability, render failure,
context loss, disposal and preventing overlapping meter queries.

Validation of this fix: `pnpm check` passes (129 unit tests and production build).
The targeted home, solar-light, lifecycle and backdrop Playwright suites report
57 passed and one expected skip for mobile mouse smoke.

## Focus-aware rendering and environment reuse

The scene now targets 60 FPS while focused and 12 FPS while visible without focus.
A hidden page schedules neither animation frames nor render timers. Inactive windows
sleep with a timeout before requesting the next display frame; they do not poll at the
monitor's refresh rate. The foreground deadline carries its remainder across display ticks
so 90/120/144 Hz displays still target 60 FPS. Inactive frames start a fresh interval
after each draw, avoiding catch-up bursts when a timer fires late. Focus and visibility
transitions cancel both pending callbacks, clear pointer interaction, and reset simulation timing before
resuming. The solar clock keeps wall time; the existing bounded water/rain timesteps
prevent a backlog of physical updates after suspension. Reduced motion remains on-demand.
Weather, detail and resize invalidations cannot restart rendering while hidden.

After the introduction, the environment cubemap and its PMREM filter update at most
15 times per second when focused, or 3 times per second without focus. The previous
complete capture is reused between updates. The intro, reduced-motion renders, focus
resumption and solar-clock discontinuities refresh it immediately. This intentionally
reduces the temporal resolution of indirect lighting; it does not lower texture sizes,
geometry detail, shadow quality or the cadence of planar water reflections. Shadow
rendering explicitly uses terrain layer 0 even when the layer-1 lake-bed camera triggers
it first on a frame without an environment capture. A fixed-scene image comparison
covers that path. Daytime motes with zero opacity no longer upload matrices or draw,
and an inactive pointer no longer causes a canvas bounds read on every frame.

The loader's Worker, fallback renderer and CSS fallback animation stop animating when
focus is lost. Their existing visibility and reduced-motion handling is retained.
The browser tests cover both loader implementations, pacing at four display frequencies,
visible/inactive/hidden transitions, invalidation while hidden, reduced-motion rendering,
resumption and disposal on Chromium and WebKit.

Research used for this change:

- [MDN Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API):
  window blur does not imply that the page is hidden; handle both signals explicitly.
- [MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices):
  reduce unnecessary submissions and avoid blocking GPU operations. The existing asynchronous
  luminance query and readback paths are retained.
- [Three.js CubeCamera](https://threejs.org/docs/pages/CubeCamera.html) and
  [PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html): environment capture
  and roughness filtering are distinct rendering work, so cache both together.

Further candidates to measure: adaptive render-buffer resolution on sustained slow frames,
independent update cadences for slow shadow lights, and a complete WebGPU renderer comparison.
Those trade image quality or require wider changes, and are not enabled by this patch.

Comparison against `35f5600`, seed 9182, midnight/heavy rain/partly cloudy: three
alternating repetitions per browser, five-second warm-up and fifteen-second samples,
with diagnostics disabled. No concurrent automated browsers were detected.

| Metric                | Chromium desktop, before → after | WebKit mobile profile, before → after |
| --------------------- | -------------------------------- | ------------------------------------- |
| Median CPU submission | 4.2 → 3.6–3.7 ms                 | 2 → 2 ms                              |
| Frame interval p95    | 16.8–33.3 → 16.7–16.8 ms         | 18 → 18 ms                            |
| Mean draw calls/frame | 1,465 → 1,253                    | 903 → 769                             |
| Mean triangles/frame  | 4.60 M → 4.12 M                  | 1.97 M → 1.75 M                       |

The deterministic time-18 captures were pixel-identical on both backends. These
captures explicitly refresh the probe, so they verify the spatial rendering changes;
they do not claim temporal equivalence for cached lighting during animation. Browser
tests separately compare a refreshed versus reused probe at a fixed scene time and
check that terrain shadows remain populated on every frame. The mobile profile runs
on the Mac GPU, not a physical phone, and WebKit CPU timing is quantized to milliseconds.
The means include the full cost of probe-refresh frames: about 14–15% fewer draw calls.
Raw samples and captures are in `artifacts/focus-perf/`.

```sh
BENCH_REPEATS=3 BENCH_SECONDS=15 BENCH_SEEDS=9182 BENCH_OUTPUT=artifacts/focus-perf pnpm benchmark:scene 35f5600
```

Chrome DevTools MCP 1.10.1 also profiled the complete local page at 1200 × 2029,
without CPU/network throttling: LCP 1,354 ms, CLS 0, nine successful network requests.
Render-blocking resources had zero estimated LCP/FCP savings. This is a local startup
observation, not a before/after comparison or a field measurement. The MCP was already
registered in Codex; setting its working directory to the user home fixes npm rejecting
startup from this repository because of its `devEngines` runtime version requirement.

Validation: `pnpm check` passes (170 unit tests, typecheck, lint, formatting and
production build). The complete Playwright suite passes 108 tests with six expected
skips for opt-in benchmarks and capabilities unavailable in the mobile profile.
