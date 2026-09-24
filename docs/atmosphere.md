# Shared wind and volumetric cloud layers

The scene uses one seeded `WindModel` for cloud advection, analytic water, CPU
pointer picking and wave scattering at rocks. The solar and weather URL parameters
are described in the solar section below. Internal `WindOptions` support weak, strong and reversed-wind experiments;
there is no weather UI.

## Wind and water

The dominant bearing is 0.72 radians in world X/Z, near the original wave spectrum.
A 3-unit/s breeze has three seeded sinusoidal gusts (frequencies 0.17, 0.071 and
0.31 rad/s; relative amplitudes 0.22, 0.14 and 0.07). A seeded lateral component
(0.023 rad/s, amplitude 1.4 times the mean speed) slowly veers the wind to either
side, including negative world-X velocity. The forward component stays positive;
turning is continuous and the wind never stops or snaps to another bearing.
Displacement is the exact integral from time zero, not instantaneous speed times
time. Sampling is stateless and independent of frame history.

Two analytic first-order vector filters, with 8-second and 2.5-second response
times, drive swells and short ripples through their magnitudes. They start in periodic steady state, avoiding a
startup transient. Long waves have 22% sensitivity; short waves approach full
sensitivity. A weighted blend preserves the original diverse spectrum. Rotating
the common bearing rotates every wave by the same amount. The intrinsic
`omega = sqrt(g*k)` phase speed is retained.

`sampleWindField` and `WIND_FIELD_GLSL` evaluate height, two spatial derivatives
and temporal velocity from identical formulas, with precomputed spectrum coefficients
shared between CPU sampling and GLSL generation. Velocity includes `amplitude' *
sin(phase) * packet` and the angular velocity of the spectrum, so gusts and turns
affect the foam signal consistently. GPU obstacle
forcing evaluates wind at each fixed simulation step, subtracting the clock's
remaining partial step; frame rate does not shift incident wave phase. CPU picking
uses the same wind state at the current visual simulation time.

## Cloud volume and composition

A deterministic 32³ RG volume packs periodic multi-octave value noise and Worley
erosion. The unused coverage and alpha channels have been removed. Sampling uses trilinear filtering and repeat
wrapping in all three dimensions. Twelve independently seeded cloud bodies repeat
in a 640-unit horizontal tile: four large banks (100–145-unit horizontal radii)
and eight smaller clouds (28–60 units), with different heights and aspect ratios.
Noise distorts and erodes each soft ellipsoidal envelope into irregular masses.
Large banks travel at 0.55–1.0 times the integrated wind displacement; smaller
clouds at 1.15–1.6 times. Each body has its own factor, so clouds overtake one
another and open/close gaps. Noise travels in each body's local frame, with only
a slow bounded deformation (0.035 rad/s). There are no resets when a body wraps:
the periodic density is continuous, including under reversed wind.

The volume occupies world heights 80–140, from a fixed sky origin at (0, 0, 0).
The layer bounds and extinction coefficient are shared by the density, sky and
shadow shaders. Rays intersect the layer and march front to back, accumulating Beer–Lambert
transmission and premultiplied in-scattered radiance. A Henyey–Greenstein phase
function (g=0.5) emphasizes lightward scattering. Three lightward density samples
approximate internal shadows; an ambient term approximates unresolved multiple
scattering. Marching stops below 1.5% transmission. The horizon fades smoothly
at the finite 2200-unit tracing limit.

| Profile | Face size | Capture rate | Maximum view-ray samples |
| ------- | --------- | ------------ | ------------------------ |
| Desktop | 256²      | 15 Hz        | 48                       |
| Mobile  | 128²      | 10 Hz        | 24                       |

The scene light, sky discs and cloud captures evaluate the same `sampleLighting`
function, including captures evaluated ahead of the visual clock.

Both profiles trace a genuine 3D volume. Two cubemaps bracket the current time;
the next capture is evaluated ahead because wind and celestial motion are deterministic.
Only one capture is replaced per tick in normal playback. A time jump rebuilds
the bracket directly, without processing missed captures. RGB stores `sqrt(radiance / 16)` to retain dim gradients in the RGBA8 fallback; the sky decodes both samples
before interpolating in linear space. A four-tap cubic B-spline reconstruction
smooths magnified cubemap texels, including diagonal outlines during wind turns;
sampling directions lets the filter cross face boundaries. It adds no per-frame
randomness and retains the original capture resolutions. The sky and GPU tests use the same
`CLOUD_SAMPLING_GLSL` compositor. Alpha stores transmission. Half-float targets
are used when supported. The noise texture is 64 KiB; both half-float
cubemaps together use about 6 MiB desktop / 1.5 MiB mobile, without depth or mipmaps.

The sky composes the atmosphere and celestial discs, then clouds, then distant relief. Actual terrain
occludes the infinite sky through the depth buffer. The sky vertex shader uses
camera rotation only, including in environment and planar reflection cameras.
All existing passes sample the same two captures and interpolation factor; none
reruns the volume marcher. The environment includes the current cloud composition
and remains synchronized with planar water reflection.

This is a stylized cloud layer inspired by Nubis, not a reproduction of
its full weather authoring or scattering system. The finite layer, sparse shadow
march and small noise volume favor soft cloud sheets over towering cumulus. The repeated tile can become recognizable over long distances. This is an advected
procedural cloud population, not a fluid simulation of cloud formation. Interpolating captures can slightly soften
fine moving edges; no random per-frame jitter is used, avoiding temporal sparkle.

## Shadows on the scene

Two Beer–Lambert transmission maps, packed into one 768×384 atlas, integrate the
same cloud bodies and noise
along the active light direction through the full layer. Each map shares its timestamp,
wind displacement and light direction with a cubemap capture; interpolation uses
the same blend. Both profiles use 384² maps with 32 integration steps in RGBA8,
adding 1.125 MiB for the pair. A single sampler keeps water within the 16-texture
limit even with seven floating lights; tile borders are clamped independently.
The shared resolution preserves narrow shadow edges
on mobile; only the capture rate follows its lower-frequency sky profile.

Receivers are projected orthographically into the corresponding light frame over
a fixed 768-unit domain. This accounts for terrain elevation and instanced voxels.
A soft boundary returns to unshadowed lighting outside the map. Each surface
samples this transmission once per fragment and reuses it for its lighting terms.
Cloud transmission
attenuates the active light's direct diffuse/specular contribution (full strength away from the horizon).
A local sky-visibility approximation also reduces ambient/diffuse environment fill
by up to 65%, environment specular by up to 35%, and in-water scattering by up to
75%, weighted by that same transmission. This makes passing shadows legible in
the night scene where indirect illumination otherwise masks them. It is not a
hemispherical sky-occlusion integral. Direct lamp lighting and emission remain
unchanged. Terrain, submerged objects and the water's analytic moon highlight
share it, including reflection captures.
The existing reflected sky already contains cloud occlusion. This approximation
assumes receivers below the cloud base. The air pass reuses this same transmission;
the decorative distant hills painted inside the sky shader do not cast shadows.

## Lifecycle and verification

Water uses the capped simulation clock; atmospheric wind and captures use wall time.
Hidden tabs skip rendering and resume at current atmospheric time. Reduced motion captures time zero once
and leaves both clouds and water frozen, including after resize. The cursor shape stays
independent of scene rendering. Its local diffuse illumination can update on pointer input. Float-target
fallback retains volumetric clouds and analytic water. Cloud targets, noise,
geometry and material are disposed with the engine.

`pnpm check` covers seeded reproducibility, integral continuity, frame-independent
sampling, smooth left/right turns, exact filter equations, finite-difference surface
derivatives, reversal, distinct cloud sizes/speeds and periodic 3D noise. `pnpm e2e` additionally compares actual GPU wave values with
CPU values, exercises stronger/reversed obstacle forcing, checks cloud transmission
range, motion, interpolation continuity, repeatability, cube edges, and sky camera
translation invariance in Chromium and mobile WebKit. Controlled weak/strong/reverse
scenarios save time-0/time-15 captures and continuous video segments aimed at the
moon. Existing tests cover seeds 0/12/9182, pointer interaction, reduced motion,
visibility recovery and unavailable float targets. Shadow tests compare the maps
with a 96-step GPU volume integral, verify elevated-receiver projection and motion
relative to the common wind, and render real instanced materials to confirm moon
and sky-fill attenuation with exactly unchanged point-light contribution.

Before the solid-terrain/cursor integration, `pnpm check` and `pnpm e2e` passed
14 unit tests and 26 browser tests.
After the RG noise packing and shared shadow-sampling cleanup, all 16 fixed-time
desktop/mobile captures are byte-identical to their pre-cleanup counterparts.
Maximum CPU/GPU surface error is 0.00006190 with half-float readback. Cloud
interpolation error is at most 0.5/255; capture boundaries are continuous and
repeated captures byte-identical. Tested cube edges differ by at most 1/255.
Transmission spans 2–3/255 to 255/255. Shadow maps differ from the 96-step reference
by at most 0.01905, with zero elevated-receiver error and exactly unchanged direct
point-light contribution. Mean shadow change remains 0.1466 even when following
the common wind displacement: the cloud population does not translate rigidly.

Desktop/mobile screenshots and sampled video frames show distinct cloud bodies,
lunar occlusion and smooth contours. Paired scene captures at 18 seconds show the
passing shadow on the right bank with stable lamps. Visual artifacts are saved
under `test-results/`, including weak/strong/reverse wind videos.

The solid-terrain/cursor integration passes `pnpm check` (17 unit tests) and
`pnpm e2e` (29 passed, one mouse-only cursor test skipped on mobile). The combined
material test checks moon and sky-fill attenuation while point and cursor lighting
remain unchanged. Seeds with seven floating lights render within the 16-sampler
limit after packing the two cloud shadow captures into one atlas.

## Performance

Measured on the same development Mac on 2026-09-23 with the existing production
`lake-visual` test: seed 9182, animation enabled, identical warmup, viewport/DPR,
and 30 steady-state animation-frame intervals before pointer movement.

| Browser / viewport                  | Before median / p95 | After median / p95 |
| ----------------------------------- | ------------------- | ------------------ |
| Chromium, ANGLE Metal, 1280×720     | 16.7 / 16.8 ms      | 16.7 / 16.7 ms     |
| WebKit, iPhone 13 viewport, 390×664 | 17 / 18 ms          | 17 / 18 ms         |

The complete suite subsequently measured 33.3 / 50 ms in Chromium and 17 / 21 ms
in WebKit. Three additional isolated page runs measured Chromium medians of
33.3–33.4 ms (p95 50 ms), and WebKit medians of 16–18 ms (p95 20–31 ms).
To check whether this was a regression, the committed engine (`3097afb`) and the
new engine were bundled independently and alternated before/after/after/before,
with the same scene-only harness, seed, viewport, DPR, 3-second warmup and 180
frame samples per trial. Chromium measured 33.3 / 49.9–50 ms before and
33.3 / 50 ms after. The slowdown was present in both engines during this later
measurement window, so these results do not isolate a cloud-rendering regression.
The same alternating comparison in WebKit measured 17 / 19 ms in all four trials.

After the independent cloud bodies, cubic reconstruction and scene shadows were
added, the full suite measured 33.3 / 49.9 ms in Chromium and 17 / 23 ms in mobile
WebKit with the same `lake-visual` parameters. A preceding focused run measured
33.3 / 33.4 ms and 17 / 20 ms respectively. These remain consistent with the later
baseline window above; they do not establish 60 fps desktop under this load.

The first short samples reached the browser's presentation limit; all samples measure frame
scheduling, not isolated GPU cost or available GPU headroom. The targets remain
60 fps desktop / 30 fps mobile. WebKit runs on the Mac with mobile viewport and
DPR emulation; physical iPhone performance has not been measured.

## References

- [Guerrilla — Nubis](https://www.guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine):
  volumetric cloud authoring, noise and lighting principles.
- [GPU Gems, chapter 1](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models):
  wind-relative directional wave spectra and analytic surface derivatives.
- [Epic Games — Volumetric Clouds](https://dev.epicgames.com/documentation/unreal-engine/volumetric-cloud-component-in-unreal-engine):
  Beer shadow maps for directional cloud shadows on the scene.
- [GPU Gems 2, chapter 20](https://developer.nvidia.com/gpugems/gpugems2/part-iii-high-quality-rendering/chapter-20-fast-third-order-texture-filtering):
  cubic B-spline reconstruction using four bilinear texture samples.

Overcast uses an advected, uneven stratus base instead of a uniform density slab.
Density above each cloud sample attenuates ambient sky light, preserving visible relief.
Cloud advection retains the weather wind direction with a 2.2 m/s minimum artistic drift;
calm weather therefore still moves visibly. Water and rain retain their own weather speeds.

## Solar cycle and atmospheric shafts

The scene starts at the visitor's local time. `timeScale` multiplies solar-clock
progress by 1–100 (default 1), while atmospheric advection and the physical simulations
retain real-time speed. Cloud illumination and terrain lighting use the same scaled clock.
`?startTime=08:30` sets the initial time (strict 24-hour `HH:MM`); invalid values use
local time. The artistic sun rises at 06:00, culminates at 12:00 and sets at
18:00. Current weather at `coordinates=latitude,longitude` selects the cloud and rain state;
Paris is the default. The solar and lunar discs are excluded from the lighting
probe because their direct energy is already evaluated by the directional light.
`seed` still determines the terrain and cloud composition.

The sky and direct lighting share `distant-horizon.ts`: the same seeded crests
block sunlight and moonlight on water, terrain and atmospheric shafts, with a soft
transition for the finite angular disc. Diffuse sky fill remains independent. This
is an infinitely distant relief approximation; nearby structures retain their
individual shadow maps. An offscreen celestial body can still illuminate the water.
The transport approach follows [PBRT transmittance](https://pbr-book.org/4ed/Volume_Scattering/Transmittance)
and the separation of direct/sky reflection in [Bruneton et al., 2010](https://morpho.inrialpes.fr/Publications/2010/BNH10/article.pdf).

`SolarClock`, `sampleLighting` and `WEATHER` separate time, lighting and weather.
Atmospheric time uses monotonic wall time, independently of the capped water
simulation timestep. Hidden tabs stop rendering; the next frame jumps to the
current atmospheric time and rebuilds both cloud capture timestamps directly.
Reduced motion freezes the initial atmosphere even after resize or visibility
changes. Future captures evaluate the lighting at their own timestamps. The
sun/moon relay fades smoothly near the horizon, and cloud shadow strength fades
with it so switching projection directions cannot flash the ambient fill.

The sky adapts the Rayleigh/Mie coefficients, phase functions and optical air
mass of [Three.js r186 Sky](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/Sky.js);
the existing volumetric clouds and painted ridges remain. The adapted sky functions
retain the [Three.js MIT notice](licenses/three-sky.txt). Shared linear colors drive cloud ambient/direct illumination, water
scattering, sky fill and decorative ridge mist. Weather changes cloud-body radii,
coverage and density independently of the air. Overcast has a continuous dense
volume with diffuse illumination. Clear bypasses cloud capture and sampling;
its cloud radiance is zero and transmission exactly one. Cloud RGB is encoded as
`sqrt(radiance / 16)` in both float and RGBA8 captures and decoded before filtering,
preserving daylight radiance above one as well as dim night gradients.

The previous ground-projected cloud shadow atlas is replaced by two 384²
orthographic light-space maps spanning 768 world units, centered on the terrain
and air volume. Each timestamp keeps its own world-to-light matrix. All points
on a light ray share UV coordinates, without dividing receiver height by the
solar elevation. Cloud integration is bounded to 2400 units, including near the
horizon; the direct solar term fades from zero to full intensity between 0° and
2°. The finite tracing distance is an approximation at grazing elevations.

After the main linear color/depth render, `VolumetricLight` reconstructs world
positions and integrates air to the nearest surface, at most 240 units and only
inside the height slab -20..80. It reads the directional light's PCF depth
comparison texture with `sampler2DShadow` and multiplies terrain visibility by
the same cloud transmission used on surfaces. The sunward view phase is
Henyey–Greenstein with g=0.6 (`dot(camera-to-scene ray, scene-to-sun direction)`).
Each segment uses the analytic exponential integral, including its zero-extinction
limit. Composition is `scene * transmission + scatteredRadiance`.

Solar scattering uses an artistic exposure of 6 with the normalized HG phase;
daytime diffuse air fill is 30% of the haze color. Denser cloud cores and subdued
cloud ambient lighting make the illuminated openings and their shafts readable
against the sky. Neither the solar disc nor a screen-space radial blur generates
these rays. Coverage still determines their contrast: a clear sky has no cloud
shafts and an opaque overcast layer blocks the direct source.

Local lamps, halos and motes fade with ambient luminance
between 0.04 and 0.24 in linear space, including the weather's diffuse factor.
Lamps and fireflies additionally adapt with a 0.9-second real-time fade, even under
an accelerated solar clock. Each lamp rises from 0.25 units below its actual terrain height to its hovering
position, then descends along that path at dawn. Seeded delays stagger emergence;
opacity, halo and emitted energy follow the motion. Fireflies approach and
disperse along individual curved, elevated routes spanning 7–12 units in several
directions. Their glow fades at the distant end, rather than extinguishing at the
colony position. Reduced motion keeps settled positions and samples lighting directly.
The lamps' emitted energy and visible geometry are zero in bright light. The outlined point stays visible. At night, its surface contact receives a cool diffuse
field with a 4.5-unit radius. A shared world-space shader illuminates material albedo and a
broad water sheen; surface normals retain the relief and wave detail. Solid picking uses the
terrain BVH and the nearest visible water contact. Sky, controls and inactive pointers fade
the field out. Cursor illumination rises only after the daylight transition ends (solar
height from -0.12 to -0.24), reversing at dawn; daylight and twilight force it to zero
regardless of cloud cover, including any remaining temporal fade. The optical lake-bed
reveal and cursor-driven caustics use that same night strength. There is no added shadow
map or point-source specular highlight. Water
gestures remain active. Text and icons keep their accessible DOM hit targets, but
their visible glyph coverage is rasterized to one texture on layout/font changes.
The last GPU overlay shades each covered pixel black or white against the
atmospheric scene texture, after matching Reinhard tone mapping. The linear-light
crossover is 0.179, with a smooth transition of ±0.025.
A nine-tap neighborhood filter spans 1.5 CSS pixels; a single letter can contain both colors as clouds move.
The glyph itself remains sharp, with a 0.325 CSS-pixel dark keyline supporting
light and intermediate ink. The keyline fades out on dark ink to preserve normal
font weight. The cursor is a separate 6-pixel DOM point: its position follows input immediately, while its
shape stretches by at most 180% along movement and compresses across it. A short CSS transition
restores its round shape; reduced motion disables strain. There is no idle animation or WebGL
cursor pass. Links enlarge the point by 65%. A matching inline SVG supplies it from the first paint.
No luminance query or GPU-to-CPU readback is needed. The backdrop is sampled before
the final small lens blur and transient rain streaks, so drops do not flash the ink.
The point uses a non-interactive popover above dialogs and during loading. Focus, links and the information dialog retain native HTML behavior; the body
disables text selection through Tailwind’s `select-none`. There is no
doubled text or dark profile veil. Cubemap reconstruction blends the
adjacent face kernels at edges to avoid seams in the denser clouds.

The air target has half the drawing-buffer resolution on each axis, with 32
samples desktop and 16 mobile. A four-tap depth-guided reconstruction rejects
samples across surface discontinuities, then the existing lens pass and final
tone mapping run. No temporal history is used. Main-view material fog is disabled
per camera to avoid double attenuation; environment and planar captures keep a
matching-distance exponential fog approximation. Air RGB uses the same 0..16
encoding as clouds for the RGBA8 fallback. The final RGBA8 scene/composite still
has less highlight headroom than the half-float path.

Full volumetric reflections in water remain out of scope. Distant clouds keep
the fixed-origin cubemap approximation. Shadow maps and volume quadrature have
finite resolution; these settings are starting quality profiles, not a guaranteed
frame rate. No rain, snow or separate weather fog effect is implemented.

### Solar verification

`lighting.test.ts` checks parsing, midnight wrapping, real-time resume, reduced
motion, the artistic orbit, transition continuity, seeded weather and light-ray
projection invariance at the horizon and zenith. `solar-light.spec.ts` captures
morning/noon/evening/night for all four presets in Chromium and mobile WebKit.
It also reads back the real GPU air targets with and without terrain occlusion,
compares 16/32 samples to 128, checks finite water/horizon radiance, unchanged
scattering when hiding the disc, and exercises RGBA8 rendering and resize.

On the controlled occluder scene, mean relative radiance errors are 2.43% (16
samples) and 0.83% (32 samples) versus 128. The homogeneous-medium maximum
relative difference is 0.188%, dominated by half-float storage. Its absolute
difference is 0.01035 at the increased HDR solar exposure. The center-ray
radiance falls from 2.998 to 1.152 with the occluder; moving the surface nearer
leaves 0.3696 scattering in front of it, with no integration behind it. These
numbers agree in Chromium and WebKit on the development Mac.

The optional `solar-performance.spec.ts` alternates independently bundled
before/after/after/before engines with seed 9182, the same browser/viewport/DPR,
three seconds warmup and 180 frame intervals per trial. Set
`SOLAR_BASELINE_BUNDLE` to the absolute path of the baseline `water-harness.ts`
ES module bundle. `PLAYWRIGHT_PORT` selects an isolated preview port when other
worktrees are being tested. Frame intervals measure scheduling, not isolated GPU
execution time; mobile WebKit uses emulation on the Mac, not a physical iPhone.

Verification on 2026-09-24: `pnpm check` passed (24 unit tests). All 51 browser
checks passed across the full suite and a targeted rerun of the two cloudy-scene
captures after removing their obsolete assumption that every daytime backdrop
needs dark text. The three normal skips are the mouse-only mobile cursor test
and two opt-in performance trials; both performance trials subsequently passed.
The cloud-edge probe now measures zero byte difference on Chromium and WebKit.

The final alternating scene-only benchmark, with stronger shafts and the
low-light lamp gating, measured:

| Browser / viewport              | Before 1 median / p95 | After 1 median / p95 | After 2 median / p95 | Before 2 median / p95 |
| ------------------------------- | --------------------- | -------------------- | -------------------- | --------------------- |
| Chromium, ANGLE Metal, 1280×720 | 33.4 / 66.6 ms        | 16.7 / 33.4 ms       | 16.7 / 33.4 ms       | 33.4 / 50.1 ms        |
| WebKit, iPhone 13, 390×664      | 18 / 31 ms            | 16 / 28 ms           | 17 / 25 ms           | 19 / 29 ms            |

The baseline is commit `aa86158`. Both trials receive the same seed, viewport
and noon URL, but the baseline only supported its original night lighting.
In particular the new daytime scene disables local lamps and their point-light
shadow work. These totals do not isolate the cost of the air pass. The benchmark
has no DOM profile, so it also excludes the once-per-second profile meter.
Earlier measurement windows had markedly different baseline frame intervals;
these figures describe this machine/session and do not establish sustained
60 fps or performance on a physical mobile device.

## Stellar sky

Seeded, direction-anchored stars fade in only after daylight reaches zero, before cloud
and horizon composition. An additional transmission mask hides stars and meteors behind
clouds, retaining visibility in clear openings. Cloudy/overcast skies suppress meteor attempts. Pixel-filtered points have subtle active-time scintillation; a seeded controller
schedules rare meteors in the current upper frustum. Both use the existing environment
capture unchanged. See [living landscape](./living-landscape.md) for cadence and validation.
