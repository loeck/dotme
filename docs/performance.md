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
scene readiness, selected backend and screenshots. Reports are written under
`artifacts/performance/` and are not functional-test pass/fail thresholds. Mobile browsers
without a WebGPU adapter are recorded under `unsupportedProfiles` and produce no GPU
frame-time measurements.

Loading responsiveness includes the largest animation-frame gap and the count/maximum
duration of long tasks until the scene is ready or fails; unsupported long-task APIs report `null`.

Console errors, including GPU shader validation failures, fail a benchmark and are
retained in its JSON report. The report records the requested Chromium adapter;
SwiftShader measurements describe CPU software rendering, not hardware GPU performance.

Set `BENCH_PROFILES=desktop` or `mobile`, `BENCH_OUTPUT` to change the output directory,
or `BENCH_URL` to sample an already running build. Compare reports generated on the same
machine, browser version, viewport, device scale and workload. Avoid simultaneous GPU
clients. Browser timing includes scheduling and presentation; it is not GPU execution
time. Mobile emulation does not establish performance on a physical phone.

Long captures and motion reviews remain outside the default suite. For image parity,
compare identical seeds and mocked weather at day/night/rain, fixed viewport and pixel
ratio. Keep representative captures with the review; do not infer visual equivalence
from a successful compilation alone.

## Low-power profile

Phones and tablets (viewport under 768 px or a coarse pointer, in either orientation)
use a reduced GPU budget independent of the portrait/landscape world variant: 30 fps
foreground cap, pixel ratio capped at 1.25, a 64 px environment probe refreshed at 4 Hz,
the moon shadow refreshed at 4 Hz and one visible lamp shadow per frame, a third-resolution
air-scattering buffer, and the mobile cloud, rain, lens and reflection budgets.

On these devices, leaning the phone left or right (gravity projected onto the screen,
so an upright phone stays stable) drives the same camera parallax as the desktop mouse.
iOS asks for motion
access on the first tap; touch parallax remains available when it is denied.
