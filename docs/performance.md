# Verification and performance

Unit tests cover deterministic physics, wave stability, weather validation, audio
scheduling, worker cancellation and resource lifecycle. The default browser suite uses
observable loading states and public DOM behavior. It covers essential journeys on
desktop Chromium and a mobile-emulated Chromium (Pixel 7). Desktop exercises WebGPU
rendering; the mobile project renders through WebGL 2 when a WebGPU adapter is
unavailable, and checks the static profile when neither backend exists. WebKit is not
tested.

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
scenes, sequentially on desktop Chromium and mobile-emulated Chromium. It discards a two-second
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

On a physical device, add `?perf` to the URL: a panel refreshes every four seconds
with the frame interval, frame CPU and the per-pass CPU and GPU time averaged over every
frame, nested passes under their parent (`main` splits into `view`, `atmosphere` and
`lens`). `dpr=<ratio>` overrides the pixel-ratio cap so the same build can be compared at
several resolutions; both parameters survive URL cleaning. A second section sums GPU time
by render target texture name (`ShadowMap`, `PointShadowMap`, `Lake reflection`, the main
view's `Landscape lens color`, ...); the canvas and unnamed targets count toward their pass.
Name new render targets to keep them separate there. `?perf=split`
instead removes one scene group at a time (water, sky, terrain, details, waterfall, rain,
lamps) and reports what each frees, pairing every removal with a fresh baseline because
phone clocks drift with heat. WebGPU needs a secure context,
so phones should open an HTTPS preview deployment, not a LAN or tailnet address.

Loading responsiveness includes the largest animation-frame gap and the count/maximum
duration of long tasks until the scene is ready or fails; unsupported long-task APIs report `null`.

Console errors, including GPU shader validation failures, fail a benchmark and are
retained in its JSON report. The report records the requested Chromium adapter;
SwiftShader measurements describe CPU software rendering, not hardware GPU performance.

Set `BENCH_PROFILES=desktop` or `mobile`, `BENCH_OUTPUT` to change the output directory,
or `BENCH_URL` to sample an already running build. Set `BENCH_COLD=1` to disable the
Dawn blob cache so every Chromium repeat measures cold pipeline compilation; without
it, repeat 0 is cold and later repeats in the same browser profile are warm. Later repeats may still improve through profile-level caches
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
0.5% of pixels, confined to the lake and the waterfall column. The fluid surface later dropped
physical transmission: it was the scene's only transmissive material, so it alone forced a
full-viewport framebuffer copy, a mip chain and bicubic backdrop taps every frame. Blending
over the backdrop pays for the procedural streaks, plunge foam and mist that replaced it.

## Loading

The first complete frame waits on three phases in turn: world data, collider and scene
construction, then shader preparation. Each phase avoids work that another thread or
pass already performs.

World data is deterministic in its seed and layout, so two instances of the world worker
each rebuild the voxel world and derive disjoint halves: terrain meshing on one, lake
surfaces, cloud noise and merged collision boxes on the other. The slower half bounds the
wait instead of their sum, and Rapier only creates colliders from boxes the worker merged.
The waterfall search reads a lake footprint raster; only the final carved world builds the
full lake bed with its shore distances and relief. The rasterization, BVH and face-coverage
loops are allocation-free rewrites with unchanged evaluation order; prepared worlds hash
identically to the earlier single-worker output for desktop and mobile seeds. A loader
frame separates collider creation from scene construction so neither forms one long task.

Shader preparation is one batch. `compile:passes` issues the clouds, sky, rain, contrast,
water-simulation and waterfall-fluid compiles; `compile:environment` establishes the probe
texture before any lit variant is built; `compile:scene` issues the probe, shadow maps,
submerged capture, main view, atmosphere and lens and settles every pass together, then
compiles the mirror view; `compile:warmup` renders once offscreen. Three's `compileAsync`
collects its render objects and restores renderer state synchronously, then builds node
graphs and driver pipelines asynchronously, so passes issued back to back interleave their
builds and the driver compiles their pipelines in parallel; awaiting them one at a time made
the loader pay their sum instead.

The lake reflection renders as a top-level pass immediately before the main view
(`LakeReflector.renderReflection`), not from inside it. Three keys render contexts by
attachment state and call depth: nested inside the view, the mirror had a context of its own
whose node graphs `compileAsync` (always at depth zero) could not prepare, so the warmup
rebuilt about forty of them synchronously and minted vertex-stage duplicate programs. At depth
zero the mirror target's attachments match the main view's, so both passes share one render
context, node graphs and pipelines; the mirror compile runs after the batch and mostly hits
the cache. Lantern glows likewise share one material with a per-object strength uniform;
per-lamp node graphs produced identical shaders but each cost a build.

Load compiles about 101 shader programs (110 in heavy rain; vertex plus fragment stages, a
loader program count of 4 is included until the loader releases), and the warmup adds 2: the
waterfall capture still renders nested inside the main view. On a desktop AMD GPU with the
Dawn blob cache disabled, these changes took scene readiness from a median of about 5.8 s to
3.9 s, the longest loading task from about 550 ms to 230 ms and the largest loader frame gap
from about 620 ms to 220 ms, with unchanged steady-state frame and GPU pass times. The per-stage program inventory
exists to catch regressions of the nested-context shape. No programs are compiled after the
first presented frame, so shader stutter does not occur at runtime.

The probe compiles and renders without the detail layer (fish, ray, fireflies,
splashes, floating bodies, foam, waterfall). Those objects are a few pixels of
the lake's indirect lighting, but compiling their materials against the cube
target minted a variant per material: with them hidden the probe drops from
about 1.4 s to 0.6 s on desktop. Shadows and the main view still compile them
normally, and the probe's object set matches at compile and render time, so no
variant is created lazily on the first runtime sweep.

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
the light direction moves by more than about half a texel. Only the two brightest lanterns cast
cube shadows (one on low power): each cube costs six caster renders and a cube sample in every
lit pixel, and unshadowed lanterns still light the bank. Those two refresh once their lantern has
drifted 8 cm (12 cm on low power), at most one per frame. The environment probe renders one cube
face per interval (about 90 ms on a focused desktop, 200 ms on low power) and filters once all
six are current; clock discontinuities restart the sweep, and the intro refreshes one face per
frame. Capillary ripples and rain rings branch past components the pixel footprint has already
faded, and the rain simulation steps at the 60 Hz frame cap.

The submerged lakebed capture renders on alternate frames, so its atlas is refreshed at 30 Hz:
the captured bed is static and only fish and caustics move in it. The captured image feeds water
refraction, so a frame of lag is invisible at these scales, and the pass costs about 1.2-1.8 ms
of GPU time per frame.

Falling water is analytic rather than rigid-body driven. The curtain parcels only ever collided
with the cursor blocker, so they integrate at a fixed 60 Hz step with the same gravity, damping
and wobble force, and resolve against the same capsule analytically. That removed 2200 Rapier
bodies and colliders from the shared world step, which was the largest single CPU cost of the
night and rain scenes.

CPU contact sampling uses a shortened spectrum. Contacts, buoyancy, foam and the rain's landing
search only need the surface to a millimetre, so the five bands shorter than a metre (1.5 mm of
combined crest, and the fastest phases of all) are skipped there: they cost five twelfths of
every query, and rain landing searches evaluate the surface five times per drop. The shaded
surface keeps the full spectrum, and the tests hold the two within 4 mm.

## Low-power profile

Phones and tablets (viewport under 768 px or a coarse pointer, in either orientation)
use a reduced GPU budget independent of the portrait/landscape world variant: 30 fps
foreground cap, pixel ratio capped at 1.25, a half-resolution fish capture, 8 capillary ripple
components instead of 32, a 64 px environment probe with one face per 200 ms,
one shadow-casting lantern, a third-resolution
air-scattering buffer, and the mobile cloud, rain, lens and reflection budgets.

The ripple count is not a per-component saving. On an Arm Valhall phone (Chrome, dpr 1)
the water surface took about 14.5 of the scene's 16 ms of GPU time, and removing any one
large block of its shader (the wave field, the ripples or the foam) dropped the scene to
3-6 ms while removing everything did no better: the full shader exceeds that compiler's
budget. Desktop GPUs show no such cliff. With 8 components the scene takes about 9 ms at
dpr 1.25 and the whole frame about 15 ms, against 21.5 ms at dpr 1 before; the image
differs in 70 of 345k pixels. Keep new water-shader work measured on such a phone with
`?perf`, since adding code can cross the cliff again.

On these devices, leaning the phone left or right (gravity projected onto the screen,
so an upright phone stays stable) drives the same camera parallax as the desktop mouse.
iOS asks for motion
access on the first tap; touch parallax remains available when it is denied.
