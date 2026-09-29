# Verification and performance

Unit tests cover deterministic physics, wave stability, weather validation, audio
scheduling, worker cancellation and resource lifecycle. The default browser suite uses
observable loading states and public DOM behavior. It covers essential journeys on
Chromium and mobile WebKit. Chromium exercises WebGPU rendering; mobile WebKit renders
through WebGL 2 when a WebGPU adapter is unavailable, and checks the static profile when
neither backend exists.

The default suite targets at most 60 seconds locally and 90 seconds in CI; those global
limits are configured in Playwright. Record the actual duration from each validation run. Reuse the existing production
build. `pnpm e2e:extended` adds detailed audio, weather, cursor and accessibility checks.
`pnpm e2e:gpu` runs separate explicit rendering checks; WebGPU cases must report a
real WebGPU backend. Failure traces and screenshots are retained.

The Linux CI runner sets `WEBGPU_ADAPTER=swiftshader`. Chromium still runs the WebGPU
API and shaders, using a software adapter; the rendering assertions remain enabled.
The launch flags follow Chromium's
[WebGPU SwiftShader test configuration](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/web_tests/FlagSpecificConfig).
Use `WEBGPU_ADAPTER=native` for hardware validation. The 90-second CI limit is a target,
not a measured CI result. Failed CI runs upload browser traces and screenshots.

CPU equations and resource ownership have deterministic unit tests. Browser journeys
and explicit GPU checks consume public scene state, rendered pixels and narrow test
interfaces. Keep tests independent of private engine fields.

## Benchmarks

```sh
pnpm build
BENCH_SECONDS=30 BENCH_REPEATS=3 pnpm benchmark:scene
```

The benchmark serves the production build and visits seeded day, night and heavy-rain
scenes, sequentially on desktop Chromium and mobile WebKit. It discards a two-second
warm-up, measures animation-frame intervals and records median/p95, loader readiness,
scene readiness, selected backend and screenshots. `frames`, `medianMs` and `p95Ms`
describe browser `requestAnimationFrame` callbacks. `sceneRender` separately records
the actual scene frames, their intervals and CPU duration, and CPU duration, GPU
duration and render calls for water, environment, submerged capture, waterfall, main
view, rain and contrast, with bed/fish and capture/filter sub-passes nested
inside the submerged and waterfall entries. The waterfall is nested inside the
main view, so their costs must not be added together. GPU durations come from
timestamp queries around each render context, attributed to the innermost open
pass; the device requests the `timestamp-query` feature when the adapter offers
it, and tracking runs only while a capture is recording. `gpuAvailable` reports
whether timestamps were usable; WebGL fallback and adapters without the feature
record CPU only. `compileStages` also carries the cumulative `programs` count
after each stage, so variant minters stand out from pure waiting. Reports are
written under `artifacts/performance/` and are not functional-test pass/fail
thresholds. Mobile browsers without a WebGPU adapter are recorded under
`unsupportedProfiles` and produce no GPU frame-time measurements.

Loading responsiveness includes the largest animation-frame gap and the count/maximum
duration of long tasks until the scene is ready or fails; unsupported long-task APIs report `null`.

Console errors, including GPU shader validation failures, fail a benchmark and are
retained in its JSON report. The report records the requested Chromium adapter;
SwiftShader measurements describe CPU software rendering, not hardware GPU performance.

Set `BENCH_PROFILES=desktop` or `mobile`, `BENCH_OUTPUT` to change the output directory,
or `BENCH_URL` to sample an already running build. Set `BENCH_COLD=1` to disable the
Dawn blob cache so every Chromium repeat measures cold pipeline compilation; without
it, repeat 0 is cold and later repeats in the same browser profile are warm. The flag
has no effect on WebKit. Later repeats may still improve through profile-level caches
the flag does not clear, such as compiled JavaScript and driver pipeline caches.
Compare reports generated on the same
machine, browser version, viewport, device scale and workload. Avoid simultaneous GPU
clients. Browser timing includes scheduling and presentation; it is not GPU execution
time. Mobile emulation does not establish performance on a physical phone.

Long captures and motion reviews remain outside the default suite. For image parity,
compare identical seeds and mocked weather at day/night/rain, fixed viewport and pixel
ratio. Keep representative captures with the review; do not infer visual equivalence
from a successful compilation alone.

## Measured budget (desktop WebGPU, 1280x720)

Per-pass GPU medians show the scene is GPU-bound: the main view takes about
13 ms on the GPU by itself. The waterfall fluid pass costs about 5 ms (capture
1 ms plus three bilateral filter passes), the submerged lakebed capture about
4 ms (bed 2 ms plus fish 2 ms) and the text-contrast overlay about 3.2 ms;
water simulation, rain slopes and the environment probe face together stay near
1 ms. CPU-side numbers understate all of this (main pass about 1.2-1.7 ms CPU),
so runtime work must be guided by the GPU columns, not the CPU ones. The fluid
volume renders from the main camera only: the mirrored capture is skipped
because the lake surface distorts it beyond recognition, which halved the
waterfall cost. The lakebed capture runs at 768 px and the fish region at half
canvas resolution; the fluid capture runs at 128 px with horizontal-only
thickness filtering. Before/after pixel parity for these cuts holds to under
0.5% of pixels, confined to the lake and the waterfall column.

Load compiles about 100 shader programs (vertex plus fragment stages; a loader
program count of 4 is included until the loader releases). The environment probe
mints the most (+29), then the submerged capture (+18), the fluid pass (+10),
the main view (+6, including the 241 KB water fragment shader) and the warmup
render (+7). The warmup additions are vertex-stage duplicates of already
compiled programs: the nested reflection render rebuilds instanced materials
with fresh generated identifier suffixes, so their code misses the program
cache. That duplication is inherent to multi-context rendering with
non-deterministic shader codegen and cannot be removed application-side; the
per-stage program inventory exists to catch regressions of this shape. No
programs are compiled after the first presented frame, so shader stutter does
not occur at runtime.

## Frame budget

Terrain chunks are split by face orientation and drawn through one `BatchedMesh` per material,
so three.js does per-object work three times per pass instead of once per chunk. Each render
culls chunks against its own frustum and skips orientations that can only face away from the
eye; with front-side materials those triangles were already back-face culled, so the image is
unchanged. Shadow cubes use the same batching with their closed-cube geometry baked per cell.
The camera only eases inside a small parallax box (`camera-rig.ts`); faces that are
back-facing to that box, its mirror image under the reflection plane and the environment probe
are dropped when the terrain is prepared, about 37% of the exposed faces.
Greedy meshing was measured and rejected: neighbouring voxel colours differ, so it would only
remove about a third of the faces while introducing T-junction pixel gaps.

Shadow casters live on a dedicated static layer, so the moon shadow map is re-rendered only when
the light direction moves by more than about half a texel. Drifting lanterns refresh their cube
shadows in a three-frame round robin. The environment probe renders one cube face per frame and
filters once all six are current; clock discontinuities, the intro and reduced motion refresh
every face at once. Capillary ripples and rain rings branch past components the pixel footprint
has already faded, and the rain simulation steps at the 60 Hz frame cap.

## Low-power profile

Phones and tablets (viewport under 768 px or a coarse pointer, in either orientation)
use a reduced GPU budget independent of the portrait/landscape world variant: 30 fps
foreground cap, pixel ratio capped at 1.25, a 64 px environment probe refreshed at 4 Hz,
one lamp shadow per frame, a third-resolution
air-scattering buffer, and the mobile cloud, rain, lens and reflection budgets.

On these devices, leaning the phone left or right (gravity projected onto the screen,
so an upright phone stays stable) drives the same camera parallax as the desktop mouse.
iOS asks for motion
access on the first tap; touch parallax remains available when it is denied.
