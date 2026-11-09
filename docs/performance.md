# Verification and performance

Unit tests cover deterministic physics, wave stability, weather validation, audio
scheduling, worker cancellation and resource lifecycle. The browser suite is a short smoke test on desktop Chromium, using observable loading
states and public DOM behavior: the page shell without JavaScript, SEO files, the 404 page,
the production security headers without CSP violations, the static profile without
graphics, a WebGPU day scene with interaction and resizing, and a reduced-motion rainy night.
The preview server applies `vercel.json`'s headers, so it runs under the production CSP.
Everything finer-grained (audio scheduling, weather, cursor, render scheduling) belongs in
unit tests. Keep the suite under about 30 seconds; Playwright's global limit is 3 minutes.
Failure traces and screenshots are retained.

The CI `e2e` job runs only the page journeys (`home.spec.ts`): its runners offer a software
WebGPU adapter (`WEBGPU_ADAPTER=swiftshader`, flags after Chromium's
[WebGPU SwiftShader test configuration](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/web_tests/FlagSpecificConfig)),
which cannot load the full scene within the test limits. Run the scene journeys locally on a
real GPU. Failed CI runs upload browser traces and screenshots.

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
`lens`). The header also shows the dynamic `scene scale` ([frame budget](#dynamic-resolution))
and whether the reduced budget took over. `dpr=<ratio>` overrides the pixel-ratio cap and the
pixel budget and fixes the scene scale at 1, so the same build can be compared at several
resolutions; both parameters survive URL cleaning. A second section sums GPU time
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

Per-pass GPU medians, seed 9182, `BENCH_SECONDS=10 BENCH_REPEATS=2 BENCH_PROFILES=desktop`,
Chromium from `scripts/with-gpu-chromium.sh` on the devbox GPU with a real WebGPU adapter (the
first repeat of the run fell back to WebGL 2 and is left out). Bed passes run on a third of the
frames and fish on two thirds, so their per-frame cost is a third and two thirds of these:

| pass (GPU ms)                             | day    | night  | rain        |
| ----------------------------------------- | ------ | ------ | ----------- |
| view (scene)                              | 9.3    | 9.3    | 10.3        |
| atmosphere                                | 1.29   | 1.31   | 1.37        |
| lens (FXAA, depth of field, bloom, grade) | 1.30   | 1.32   | 1.37        |
| submerged bed, per capture                | 1.17   | 1.16   | 0.95        |
| water simulation                          | 0.40   | 0.39   | 0.42        |
| environment (probe face + sky reflection) | 0.16   | 0.16   | 0.17        |
| waterfall capture + filters               | 0.11   | 0.11   | 0.11        |
| rain overlay / slopes                     | -      | -      | 0.25 / 0.06 |
| contrast, fish                            | ≤ 0.04 | ≤ 0.04 | ≤ 0.04      |

The view dominates; frames hold the 60 Hz cap by day and at night (p95 16.7-16.8 ms) with
about 10 ms of main-thread work per frame, while heavy rain needs about 18 ms of CPU per frame
and misses frames on the CPU (p95 33 ms), not the GPU. Earlier figures in this section (main
view 13 ms, waterfall 5 ms, lakebed 4 ms, contrast 3.2 ms) came from another machine and an
older scene and are not comparable. The fluid
volume renders from the main camera only: the mirrored capture is skipped
because the lake surface distorts it beyond recognition, which halved the
waterfall cost. The lakebed capture runs at 768 px and the fish region at half
canvas resolution; the fluid capture runs at 128 px with horizontal-only
thickness filtering. Before/after pixel parity for these cuts holds to under
0.5% of pixels, confined to the lake and the waterfall column. The fluid surface later dropped
physical transmission: it was the scene's only transmissive material, so it alone forced a
full-viewport framebuffer copy, a mip chain and bicubic backdrop taps every frame. Blending
over the backdrop pays for the procedural streaks, plunge foam and mist that replaced it.

The lake mirror previously showed the fall through a reflection-only ribbon
(`WATERFALL_REFLECTION_LAYER`) rather than the fluid volume, with mist and spray omitted.
On the same machine, with
interleaved before/after runs, the `Lake reflection` target stayed at about 1.36-1.56 ms on
desktop and the summed GPU time per frame moved by under 0.1 ms; pairing each removal of the
waterfall group with a fresh baseline gave about 2.8 ms for the group before and after on desktop
and 1.9-2.0 ms at noon in the Pixel 7 emulation. Emulated mobile runs use the desktop GPU, vary
by more than 2 ms between runs and say nothing about a phone; measure there with `?perf=split`.
The close-up foam octaves cost only where the foam covers enough pixels to show them. The ribbon
adds two or three programs at the scene stage and none after the first presented frame.
The current reflection uses a low-poly instanced curtain sharing the live parcel streams,
so cursor deflections appear in the lake. It still avoids a second fluid capture, but the
ribbon timings above do not measure this replacement.

## Loading

The first complete frame waits on three phases in turn: world data, collider and scene
construction, then shader preparation. Each phase avoids work that another thread or
pass already performs.

World preparation starts before the GPU device is requested, so the workers overlap device
creation, the loader and the landscape download. World data is deterministic in its seed and
layout, so three instances of the world worker each compose the lake again and derive disjoint
parts: the smooth terrain mesh and boulders on one, lake surfaces, cloud noise and the static
colliders on another, the forest on the third. The slowest part bounds the wait instead of their
sum (the forest, about 0.9 s after composing the lake, used to follow the surfaces on the same
worker). The forest posts on its own, so world data does not wait for vegetation. The forest is still part of the first
frame: the engine adds it after building the scene and compiles it for the main view, the mirror,
the probe and the shadow maps in the same sequence as the scene (`vegetation-ready` and
`vegetation-presented` marks). Meshes that stay hidden until something happens (falling leaves,
the flock, the skipping stone, the wave ring, lanterns, bats and insects) are shown for that
compile sequence, so their programs exist before the first frame rather than compiling when a
gust, the demonstration stone or dusk first brings them out. Rapier only creates a heightfield and boulder hulls the worker
prepared. The waterfall search reads the composed ground directly; the lake bed derives from the
smooth ground ([terrain](terrain.md)). Generating the world takes about 0.3 to 0.5 s on desktop in
Node; the forest alone takes about another 0.9 s. A loader frame separates collider
creation from scene construction so neither forms one long task.

Rapier's compat package inlines its WebAssembly as base64 in a 4.3 MB script (1.67 MB gzip)
that had to download, parse and decode before `init` could even compile it. Production builds
now extract that module into a hashed `rapier-*.wasm` asset (3.1 MB, 1.19 MB gzip; the script
drops to 225 kB, 40 kB gzip) with a small Vite plugin (`rapier-wasm-file` in `vite.config.ts`)
that replaces the package's base64 literal with `src/scene/rapier-wasm.ts`. That module starts
`WebAssembly.compileStreaming` (needs `application/wasm` and the CSP's `'wasm-unsafe-eval'`)
from `src/main.ts`, next to world preparation and before the GPU device, so compilation runs
off the main thread while the workers prepare the world; `init` then only instantiates the
compiled module. The `physics-start`/`physics-ready` span, measured from the landscape's
request, fell from 160-220 ms to 50-60 ms on the benchmark above (about 70 ms on the cold
WebGL repeat, from 270 ms); with a cached world, scene readiness moved from 2.15-2.49 s to
1.87-2.13 s by day and at night and stayed at 2.2-2.3 s in heavy rain. The build fails if the
package no longer contains exactly one inlined module. Development serves the package as
published. Physics still precedes scene construction: rain, fish, splashes, floating bodies and
pointer picking take the Rapier world in their constructors, and it is no longer on the
critical path once compiled early.

### World cache

Production builds keep the prepared world between visits in the origin private file system
(`world-cache.ts`), one file per part and profile (desktop or mobile): a JSON header naming the
file format, generator version and seed, then the part's typed arrays, aligned and deflated as
one `deflate-raw` stream (`CompressionStream`; browsers without it store them raw). The version
is the content-hashed URL of the worker bundle, so any change to the generator retires stored
worlds, and the format constant retires older files. Each world worker reads its own part before
generating it, inflates it straight into one buffer of the recorded size and rebuilds every
typed array as a view at its aligned offset in that buffer, so a hit holds one copy of the part
rather than two; the part is transferred to the page as that single buffer, like a generated
part. Reads, decoding and writes never run on the render thread. Development builds have no
hashed worker and always generate.

Four seconds after the first frame, once the main thread is idle, a single background worker
prepares the world of the next visit and stores it with `createWritable`, which commits each file
atomically. It is skipped when the visitor asked to save data (`navigator.connection.saveData`),
on low-power devices (the generation competes with the scene for a phone's cores and battery;
their visits generate, as before), in a hidden tab, and when `navigator.storage.estimate()` shows
the world would bring usage past half of the quota (budgeted at 40 MB on desktop, 10 MB on
phones; an unknown estimate does not block). A random visit draws a new seed for it and
remembers that seed in `localStorage` only once stored; the next visit consumes it, so every
visit still shows a new world, and a visit that never stored one simply generates. A URL seed is stored as is, so its reload is cached too.

On seed 9182, a desktop world was 96.7 MB of raw files (terrain 16.0, surfaces 33.2, vegetation
47.4; mobile 23.3 MB) and is now 30.1 MB (5.4, 10.0, 14.7; mobile about 8 MB in Node): float
meshes, index buffers and the foliage atlas all deflate about threefold. In Node, deflating a
desktop world takes under a second on the background worker and inflating it 15–50 ms per part.
Quantizing in the generator (16-bit positions, oct-encoded normals, 16-bit indices) would shrink
it further but changes what fresh and cached loads render, and byte-shuffling the arrays before
deflate saved another 22% for an extra pass on every read; neither was taken. In headless
Chromium (desktop, WebGL 2, seed 9182, two reloads) a cached world is ready 153–173 ms after
`worldprep-start` and its forest after 174–191 ms, against 122–125 and 122–133 ms with raw files,
while a cold load generates in about 0.8 s and its forest in 1.8–2.2 s. An earlier IndexedDB
store of the same values kept the browser busy long after the page had gone: a reload within
seconds stalled its shader compiles for 10 to 40 s. Plain files showed no such stall. The `worldprep-cached` mark
records a world served entirely from the cache; the benchmark reports it as `worldCached`.

Open-Meteo reports current conditions per 15-minute slot, so the last response is kept in
`localStorage` and reused while its slot is current; a reload then skips the weather request.
Hashed assets are served `immutable` for a year (`vercel.json`), so a reload revalidates none of
them.

On the desktop AMD GPU used for the measurements above, reloading one tab every 12 s, with
before/after runs interleaved: the previous build presented the scene after 4.1-4.4 s on every
reload. Now a cached URL seed presents after 1.9-2.2 s (its world is ready about 0.1 s after the
script starts, before the loader's first frame), a random visit served the world the previous
one prepared after 2.5-3.0 s, and an uncached load after 2.9-3.7 s (forest on its own worker,
three r187's faster compile). Shader preparation is now most of a cached load.

Shader preparation is one sequence. `compile:passes` compiles the clouds, sky, rain, contrast,
water-simulation and waterfall-fluid passes while the forest is still arriving;
`compile:environment` establishes the probe texture before any lit variant is built;
`compile:scene` compiles the probe, shadow maps, submerged capture, main view, atmosphere and
lens, then the mirror view; `compile:warmup` renders once offscreen. Since three r187,
`compileAsync` processes its render objects one by one under a frame budget and compiles their
driver pipelines in parallel while it builds the next node graphs, but it keeps a single
precompilation state on the renderer: two calls in flight that share a node build swap each
other's render target and context, which fails the load. Calls therefore run one at a time,
and each task sets up its scene state (hidden water, shadow override material) when it runs
rather than when it is queued. On r186 the same passes were issued back to back so their builds
interleaved; r187's in-call parallelism made the sequence faster than that batch (scene stage
about 1.0 s instead of 1.6 s on the first, uncached load).

The lake reflection renders as a top-level pass immediately before the main view
(`LakeReflector.renderReflection`), not from inside it. Three keys render contexts by
attachment state and call depth: nested inside the view, the mirror had a context of its own
whose node graphs `compileAsync` (always at depth zero) could not prepare, so the warmup
rebuilt about forty of them synchronously and minted vertex-stage duplicate programs. At depth
zero the mirror target's attachments match the main view's, so both passes share one render
context, node graphs and pipelines; the mirror compile runs after the main view and mostly hits
the cache. Lantern glows likewise share one material with a per-object strength uniform;
per-lamp node graphs produced identical shaders but each cost a build.

On the current scene the renderer counts 120 programs after the warmup (130 in heavy rain;
vertex plus fragment stages, a loader program count of 4 is included until the loader
releases); the waterfall capture still renders nested inside the main view. On a desktop AMD GPU with the
Dawn blob cache disabled, these changes took scene readiness from a median of about 5.8 s to
3.9 s, the longest loading task from about 550 ms to 230 ms and the largest loader frame gap
from about 620 ms to 220 ms, with unchanged steady-state frame and GPU pass times. The per-stage program inventory
exists to catch regressions of the nested-context shape. The goal is that no program compiles
after the first presented frame; the benchmark currently still counts 2 more in steady state
(122, or 132 in rain; the original build of this measurement counted 4 more), which remain to be
traced. Weather that may change after the first frame (live or fallback, not a forced
`?weather=`) also compiles the cloud capture, rain and snow at load even when they start hidden,
so a refresh that brings cloud, rain or snow compiles nothing (measured: no program added through
a clear-to-rain or clear-to-snow refresh). The rain and snow materials compile in the overlay's own
state, which removed two programs from a rainy first frame.

The probe compiles and renders without the detail layer (fish, ray, fireflies,
splashes, floating bodies, foam, waterfall). Those objects are a few pixels of
the lake's indirect lighting, but compiling their materials against the cube
target minted a variant per material: with them hidden the probe drops from
about 1.4 s to 0.6 s on desktop. Shadows and the main view still compile them
normally, and the probe's object set matches at compile and render time, so no
variant is created lazily on the first runtime sweep.

## Frame budget

The terrain is one static mesh and the boulders another, each with a single material, so
three.js does per-object work twice per pass. On seed 9182 they total about 336k triangles on
desktop and 87k on phones, against 798k and 146k for the voxel terrain with its micro-voxels
([terrain](terrain.md#shadows-and-cost)). Quads under the water are not meshed.

Shadow casters live on a dedicated static layer, so the moon shadow map is re-rendered only when
the light direction moves by more than about half a texel. It is filtered by a fixed 3×3 grid of
bilinear comparisons (centre and corners on low power, `stable-shadow.ts`) rather than three's
default PCF, which rotates five taps by screen-space noise: that pattern stays on the screen
while shadow edges slide under it, so edges shimmered whenever the view moved quickly or the
intro's time-lapse swept the sun. The fixed grid is anchored to the map and costs four taps more
per lit pixel on desktop. The casters are depth-only twins of the
terrain and boulder meshes that share their geometry. Only the two brightest lanterns cast
cube shadows (one on low power): each cube costs six caster renders and a cube sample in every
lit pixel, and unshadowed lanterns still light the bank. Those two refresh once their lantern has
drifted 8 cm (12 cm on low power), at most one per frame. The environment probe renders one cube
face per interval (about 90 ms on a focused desktop, 200 ms on low power) and filters once all
six are current; clock discontinuities (more than a second of atmosphere time between two
frames) restart the sweep, and the intro refreshes one face per frame. The jump is measured from
the previous frame rather than from the sweep's first face: a low-power sweep (six faces 200 ms
apart) spans just over a second, so it was restarted before being filtered and the lighting stayed
stale. In the WebGL captures, crowns were then about a quarter darker, and they brightened in a
single frame whenever frame timing let a sweep finish. The lake's sky reflection does not wait for that sweep: a sky-only cube (the dome and
its cloud lookup, no geometry, 128 px faces or 64 on low power, mipmapped instead of filtered)
refreshes two faces per frame, each upper face twice every five frames, inside the same
`environment` diagnostics pass. The lake only reflects the upper hemisphere, so -Y waits for a
full capture, which renders all six faces during the intro, under reduced motion, while
lightning flashes and whenever the sun moves visibly between frames (time-lapse, scrubbing,
clock jumps). The pass went from 0.46 to 0.16 ms of GPU time per frame. Capillary ripples and rain rings branch past components the pixel footprint has already
faded, and the rain simulation steps at the 60 Hz frame cap.

The submerged lakebed atlas keeps its two regions between refreshes. Fish move, so their region
renders every other frame (30 Hz); the bed region only sways its seagrass and moves its
caustics, which live in the bed materials (`lake-caustics.ts`), so it renders on every other
fish frame (15 Hz), and on every fish frame while the intro's time-lapse moves the light. A bed
refresh only lands on a fish frame, which redraws the fish after it, so the fish keep an even
cadence. Attachment clears cover the whole atlas on WebGPU, so a fish-only frame clears its
region with a scissored quad (transparent black at the far plane, depth-tested with an
always-passing function so WebGL still writes its depth; one program compiled with the scene).
The captured image feeds water refraction, so the lag is invisible at these scales. On the
benchmark the bed costs 1.0-1.2 ms per capture: about 0.3 ms per frame at 15 Hz, down from
0.57 ms at 30 Hz.

The lens skips its 20-tap depth-of-field disc where the FXAA neighbourhood is flat (display luma
range under 0.012): the disc spans at most 1.35 CSS pixels and would return the pixel itself
there (open sky, clouds, calm water). The lens pass measured the same (1.30-1.37 ms) before and
after on this GPU, so the saving is within noise here; the images did not change visibly.

The text-contrast overlay covers only the bounding box of the profile and the two scene
controls (plus 8 CSS pixels) instead of the viewport: its mask canvas and quad follow that box,
re-measured on resize observers and every 250 ms against layout shifts, so it also follows the
profile while it fades in. It samples the graded backdrop four times (diagonal taps over the old
3×3 tent) instead of nine, and the mask rebuilds on hover only over the profile's links (their
underline) rather than on every pointer move inside `main`. It costs under 0.05 ms here.

The waterfall fluid pass is 0.08 ms of capture and 0.03 ms of filtering at 128² on this GPU. Its
depth and thickness captures cannot share one MRT pass: depth is depth-tested with no blending,
thickness is additive without depth testing, and three applies one material's blend and depth
state to every attachment.

Frame-loop allocations are gone from the hot paths: `sampleLighting` writes into a state the
engine reuses (and one for the clouds), the wind is sampled once per frame, a lightning frame
writes its exposure into a reused look, the async pointer step only starts when a pointer event
is pending, the fluid and lakebed passes keep their saved renderer state in fields, and the
waterfall uploads its foam attribute only when a value changed (positions and velocities change
for every parcel each step and still upload whole).

### Dynamic resolution

The scene resolution is capped by pixel count as well as ratio: 2.2 MP on desktop (pixel ratio
at most 1.75) and 1.2 MP on low-power devices (at most 1.25), so a 1440p window or a dense tablet
gets a lower ratio rather than a larger image (`pixelRatioFor` in `device-profile.ts`). Only the scene pays for that: its targets render at
the budget share, while the canvas keeps the display ratio (capped at 1.75, or 1.25 on low-power
devices) so the profile text and icons drawn there stay sharp.

The scene then renders its view, air and mirror at a dynamic share of that buffer, which the
lens upsamples onto the canvas (`RenderScaleController`, `render-scale.ts`). Shares are quantized
to 0.6-1.0 in steps of 0.1, so the targets reallocate rarely; no shader program changes. The
controller ignores the first five seconds (the intro), pauses over 250 ms (background, hitches)
and frames whose main-thread work exceeds 80% of the budget, since a smaller image would not
help a CPU-bound frame (heavy rain here). It looks at the 90th percentile of frame intervals
over 1.5 s: above 1.25 × the budget (16.7 ms, or 33.3 ms at the low-power 30 fps cap) it steps
down; within 1.08 × for 4 s it steps up, waiting twice as long (up to 32 s) after a step up it
had to undo. Changes are at least 2 s apart. Six seconds late at 0.6 switch to the reduced
budget, for knobs that compile nothing: the low-power pixel budget, probe interval and mirror
resolution. A browser holding the page at a lower rate (a battery saver's 30 Hz) shows steady
intervals at a whole multiple of the budget that no step shortens: once the descent reaches 0.6
without a gain, the controller restores the share it left and aims for that rate instead of
switching budgets. `?dpr=` turns all of this off. On this GPU the WebGPU benchmark never left 1.0 by
day or at night; the WebGL 2 path settled at 0.9 at night.

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
foreground cap, pixel ratio capped at 1.25 and 1.2 MP, a half-resolution fish capture, 8 capillary ripple
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
