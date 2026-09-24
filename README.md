# loeck.me

Static personal site built with Vite, HTML, TypeScript, Tailwind and Three.js. The profile, social
icons and SEO metadata are in the HTML and work without JavaScript. The procedural voxel lake
loads through a dynamic import. Each visit gets a fresh landscape seed.
Add `?seed=42` to the URL to reproduce one composition.

A full-screen voxel loader covers the initial scene preparation. Five cubes render in a tiny,
independent WebGL canvas at 30 Hz, using an OffscreenCanvas worker when available. It requires no
Three.js import, textures or shadow passes. The first completed scene frame reveals the landscape
and profile together through a 600 ms fade, then releases the loader's graphics resources and worker.
The cubes assemble from the center into a balanced small landscape (three below, two centered above),
hold for a second, then return to their line in a 5.2-second loop. Both resting shapes share the same
visual center. Reduced motion shows the assembled shape and skips the fade.
Initialization failures or a 20-second
timeout release the profile; without JavaScript the static profile is immediately available.

## Requirements

- Node.js 24.21.0
- pnpm 12.5.1

## Development

```sh
pnpm install
pnpm dev
```

For parallel visual work, start each preview with `pnpm dev --port 0`. Vite prints the free port it
selected, so agents can capture separate previews without a shared fixed port.

## Scene URL

Only four query parameters are supported; other keys are removed from the URL.

| Parameter     | Example          | Meaning                                                                               |
| ------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `seed`        | `42`             | Reproduce the terrain and procedural composition (unsigned 32-bit integer).           |
| `coordinates` | `48.8566,2.3522` | Latitude, longitude for current weather. Defaults to Paris.                           |
| `startTime`   | `08:30`          | Initial artistic clock in 24-hour HH:MM format. Defaults to the visitor's local time. |
| `timeScale`   | `20`             | Day/night speed multiplier, from 1 to 100; defaults to 1.                             |

Example: `?seed=42&coordinates=48.8566,2.3522&startTime=08:30&timeScale=20`.
Values outside the speed limits are clamped; invalid values use 1. Only the solar cycle
accelerates: clouds, water, fish and rain retain their normal movement. Legacy `gps` and
`time` links are rewritten to the canonical names.
Weather is fetched live; changing the clock does not request a forecast for that hour.
The same link can show different weather on another visit. Without a seed, each visit
generates a fresh composition. Invalid values use the defaults.

## Live lighting

Sunlight, moonlight and lamps cast shadows on the voxel scenery and water.
The atmosphere follows local time at the selected speed, with an artistic 06:00 sunrise and
18:00 sunset. Air scattering uses terrain
and cloud shadows, so shafts can remain visible with the sun outside the frame.
Profile text and icons use a GPU coverage mask: each pixel turns black or
white from the rendered luminance underneath, including within a single letter.
DOM text and controls retain keyboard access and screen-reader semantics.
Text selection is disabled globally through Tailwind’s `select-none` on the body.
Floating lamps and their halos appear only
in low light; pointer ripples remain available during the day.
Reduced motion freezes the initial time. Each animation
frame updates the light state, shadow maps, a six-face environment capture, and the lake's planar
reflection before the final lens pass. Floating light cubes, halos and water highlights share the
same light intensity. Voxel materials store base colors without baked lamp illumination.

Wet banks, dry ground and stone have different roughness. The water evaluates live lights
and their shadows with a GGX specular response; waves and pointer ripples distort the reflected scene.
The lake combines a directional wind spectrum with a persistent GPU height/velocity field
(1024² desktop, 512² mobile), stepped at 60 Hz independently of the display rate. Twelve wave
components form curved, localized packets; their analytic gradients preserve fine ripples at
mobile resolution. A volume-balanced pressure profile is sampled along pointer strokes, with
bounded input strength. A nine-point stencil propagates and combines waves; the terrain mask
reflects them at banks and an absorbing border prevents waves returning from the outer domain.
In low light, hover subtly reveals the shallow, refracted lake bed. Dragging strengthens the wake and preserves
the general camera parallax. See the rendering notes below for physical parameters and limitations.

The solver is a damped linear surface-wave approximation with constant propagation speed. It does
not model depth-dependent dispersion, breaking waves or volumetric fluid flow.

References: [Evan Wallace's WebGL Water](https://madebyevan.com/webgl-water/),
[GPU Gems: the 2D wave equation](https://developer.nvidia.com/gpugems/gpugems2/part-vi-simulation-and-numerical-algorithms/chapter-44-gpu-framework-solving),
[Fix Your Timestep](https://gafferongames.com/post/fix_your_timestep/).

Solid surfaces use one shared, filtered environment probe, so their reflections approximate local
parallax. The probe excludes the lake to avoid recursive reflections; the lake uses its own reflected
camera. This is a rasterized rendering pipeline with approximate indirect illumination.

Visible terrain uses spatial batches of static meshes with covered faces removed. Shadow cameras
use smaller batches of the original cubes to preserve back-face shadow depth. Mobile uses
smaller shadow maps and reflection targets; every rendered frame still refreshes lighting and
reflections. Reduced motion freezes the simulation while allowing refreshes on resize or visibility changes.
A 6-pixel outlined point follows the pointer immediately. Only its shape stretches slightly
with speed and settles within 245 ms; reduced motion disables deformation. Links and buttons enlarge the same point. An inline SVG supplies the matching cursor before
JavaScript starts, with no separate image request. In low light, a short-range cool diffuse
light follows the targeted terrain or water. It fades with ambient brightness and pointer
activity; reduced motion keeps its intensity immediate.

## Verification

```sh
pnpm check
pnpm exec playwright install chromium webkit
pnpm e2e
```

See [lake rendering notes](docs/lake-water.md) for physical parameters, input behavior,
GPU validation, performance methodology and approximations. See [scene performance](docs/performance.md)
for Worker preparation, pass diagnostics, the reproducible A/B benchmark and the isolated WebGPU compute prototype.

## Vercel

Import the repository in Vercel with the repository root as the project root. `vercel.json` selects
Vite and publishes the static `dist` directory. No server functions or SPA rewrites are needed.
Vercel serves `404.html` for unknown paths; development and preview use the same page with HTTP 404.
Other static hosts should also be configured to serve that page with a 404 status.

See [bundle measurements](docs/bundle-size.md) for the initial and total JavaScript comparison, and
[Weather access](docs/paris-weather.md) for the Open-Meteo preload. Conditions at the selected GPS position set the
clouds, rain and wind before the first frame. A 3-second deadline or API failure selects a stable,
random weather preset for the visit. The small information button opens the creation notes and credits.

See [atmosphere notes](docs/atmosphere.md) for the shared wind, volumetric cloud rendering,
quality profiles and before/after performance measurements.

The lake also includes subtle caustics, small voxel fish shoals
and reactive amber fireflies. Bank materials retain
moisture when supplied with rain intensity. See [living lake details](docs/scene-details.md)
for rendering budgets, the rain/daylight integration API, reduced-motion behavior
and validation.

Small voxel fish travel in up to four independent shoals (26 fish on desktop, three shoals / 15 fish on mobile).
Their vertices are refracted analytically and composited on the water with depth-tested
bank occlusion, avoiding fragmented silhouettes from the bed texture. Shoals overlap,
arrive and dive away on independent routes; reduced motion keeps one quiet, static group. The submerged
bed retains wave-driven caustics. Local mist billboards are removed to prevent long
horizontal ribbons; distant volumetric haze remains. Rain reduces underwater clarity
and adds a warmer scattering tint, while shared wind and rain roughen the surface.
Cloud cover changes lighting without automatically making the water muddy. This is an
artistic response to the weather, not a measurement of water quality.

References: [GPU Gems: water caustics](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-2-rendering-water-caustics),
[GPU Gems: refraction](https://developer.nvidia.com/gpugems/gpugems2/part-ii-shading-lighting-and-shadows/chapter-19-generic-refraction-simulation),
and [USGS: turbidity](https://www.usgs.gov/water-science-school/science/turbidity-and-water).

## Rain

`RainEffect` receives the initial GPS weather state during loading. Use
`engine.setRainState({ intensity: 0.55, wind: { x: 2, z: 0.5 } })` to replace its state.
Intensity is clamped to 0–1; horizontal wind is in world metres per second, bounded to ±20.
One world unit is treated as one metre. Non-finite values fall back to the defaults above.

A fixed 120 Hz simulation shares world-space positions and velocity between streaks and
segment/voxel collisions. Small drops are more frequent, fall more slowly and follow wind
changes faster. The visible fall speeds are calibrated to 6.2–11.5 m/s for this scene.
Streaks use a virtual 1/48 s exposure, varied procedural brightness and live
moon/lamp lighting. Their own depth controls their aperture blur; they composite after the
surface lens pass using the resolved scene depth for occlusion. The lake's reflected camera
includes rain on layer 2, while the environment cube probe and the submerged-bed capture
(layer 1) exclude it.

Each water collision retires its drop and records one pooled impact. Its analytic capillary–gravity
wave packets are rasterized additively into a half-float **screen-resolution slope texture**.
World-space footprints follow the camera. Gaussian reconstruction filters each wave packet in
its radial direction using the projected pixel's variance (1/12 of its squared width), preserving
waves across the short axis of grazing pixels. Unresolved slope energy is stored in the texture's
blue channel and broadens water highlights and planar reflections instead of vanishing.
This is an isotropic roughness approximation inspired by normal-distribution filtering, not a full
LEAN implementation. Combined slopes drive water normals, lighting, Fresnel and reflections.
A brief millimetre-scale depression marks contact; nearby larger impacts also emit asymmetric
crowns and ballistic secondary droplets, with a tighter surface-focus footprint than airborne rain.
Collisions use the mean lake plane; impact geometry samples the same wind and pointer
displacement fields as the lake. The rain wind API remains independent of the atmosphere wind.
The pointer simulation remains independent. This approximates surface waves and rain optics;
it does not simulate volumetric fluid, optical scattering or splashes on solid ground.

Pools are capped at 12,000 drops / 7,000 impacts / 128 simultaneous splashes on desktop and
4,000 / 2,400 / 48 on mobile, with lower mobile emission (1,400 vs 4,200 drops/s at full intensity).
The near-field emission volume narrows toward the camera to concentrate the budget in view.
Saturated drop pools skip births only after searching all slots. Rain retains real-time speed
down to 10 fps with bounded 100 ms catch-up, independently of the water solver’s 50 ms limit.
Reduced motion suppresses rain, animation stops while the page is hidden, and all buffers,
materials and targets are disposed with the landscape. Setting rain intensity to zero clears existing events and
skips rain simulation/draw passes after clearing the slope target once. When floating-point
render targets are unavailable, rain streaks and splashes remain but slope accumulation is disabled.
The static depth/shore grids share one atlas, retaining their native resolution and filtering while
keeping the water shader within the 16-sampler budget with all lamp shadows.

Rain validation: unit tests cover segment collisions, shelters, impact synchronization,
wind response, refresh-rate independence, parameter parsing and pool bounds. Playwright
captures all four presets on desktop/mobile and attaches median/p95 frame-time measurements
for comparison (hardware-dependent, not CI performance thresholds). An isolated browser harness
exercises the public state API, visibility pause/resume, resize and disposal, and records CPU frame
submission costs with rain off/heavy; these CPU timings exclude GPU execution.
It also reads the actual GPU impact field to verify signed wave slopes, retained subpixel variance,
finite output, and an empty field when rain is off.

References: [Garg and Nayar, Photorealistic Rendering of Rain Streaks](https://cave.cs.columbia.edu/Statics/publications/pdfs/Garg_TOG06.pdf),
[Sébastien Lagarde, Dynamic rain and its effects](https://seblagarde.wordpress.com/2013/01/03/water-drop-2b-dynamic-rain-and-its-effects/),
[Le Méhauté, Gravity–capillary rings generated by water drops](https://doi.org/10.1017/S0022112088003301),
[Experimental Study of Drop Impact on Deep-Water Surface in the Presence of Wind](https://journals.ametsoc.org/view/journals/phoc/48/2/jpo-d-17-0172.1.xml),
[Olano and Baker, LEAN Mapping](https://userpages.cs.umbc.edu/olano/papers/lean/),
and [Three.js instanced buffer geometry](https://threejs.org/docs/pages/InstancedBufferGeometry.html).
