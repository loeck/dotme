# Shared wind and volumetric cloud layers

The scene uses one seeded `WindModel` for cloud advection, analytic water, CPU
pointer picking and wave scattering at rocks. React props and URL parameters are
unchanged. Internal `WindOptions` support weak, strong and reversed-wind experiments;
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
function (g=0.5) emphasizes moonward scattering. Three moonward density samples
approximate internal shadows; an ambient term approximates unresolved multiple
scattering. Marching stops below 1.5% transmission. The horizon fades smoothly
at the finite 2200-unit tracing limit.

| Profile | Face size | Capture rate | Maximum view-ray samples |
| ------- | --------- | ------------ | ------------------------ |
| Desktop | 256²      | 15 Hz        | 48                       |
| Mobile  | 128²      | 10 Hz        | 24                       |

The scene light, sky disc and cloud captures evaluate the same `sampleMoonLight`
function, including captures evaluated ahead of the visual clock.

Both profiles trace a genuine 3D volume. Two cubemaps bracket the current time;
the next capture is evaluated ahead because wind and lunar motion are deterministic.
Only one capture is replaced per tick in normal playback. A time jump rebuilds
the bracket directly, without processing missed captures. RGB stores square-root
radiance to retain dim gradients in the RGBA8 fallback; the sky decodes both samples
before interpolating in linear space. A four-tap cubic B-spline reconstruction
smooths magnified cubemap texels, including diagonal outlines during wind turns;
sampling directions lets the filter cross face boundaries. It adds no per-frame
randomness and retains the original capture resolutions. The sky and GPU tests use the same
`CLOUD_SAMPLING_GLSL` compositor. Alpha stores transmission. Half-float targets
are used when supported. The noise texture is 64 KiB; both half-float
cubemaps together use about 6 MiB desktop / 1.5 MiB mobile, without depth or mipmaps.

The sky composes the moon and halo, then clouds, then distant relief. Actual terrain
occludes the infinite sky through the depth buffer. The sky vertex shader uses
camera rotation only, including in environment and planar reflection cameras.
All existing passes sample the same two captures and interpolation factor; none
reruns the volume marcher. The environment includes the current cloud composition
and remains synchronized with planar water reflection.

This is a stylized, calm nocturnal layer inspired by Nubis, not a reproduction of
its full weather authoring or scattering system. The finite layer, sparse shadow
march and small noise volume favor soft cloud sheets over towering cumulus. The repeated tile can become recognizable over long distances. This is an advected
procedural cloud population, not a fluid simulation of cloud formation. Interpolating captures can slightly soften
fine moving edges; no random per-frame jitter is used, avoiding temporal sparkle.

## Shadows on the scene

A pair of Beer–Lambert transmission maps integrates the same cloud bodies and noise
along the moon direction through the full layer. Each map shares its timestamp,
wind displacement and lunar direction with a cubemap capture; interpolation uses
the same blend. Both profiles use 256² maps with 32 integration steps in RGBA8,
adding 512 KiB for the pair. The shared resolution preserves narrow shadow edges
on mobile; only the capture rate follows its lower-frequency sky profile.

Receivers are projected along the corresponding moon direction onto a fixed
512-unit ground domain. This accounts for terrain elevation and instanced trees.
A soft boundary returns to unshadowed lighting outside the map. Each surface
samples this transmission once per fragment and reuses it for its lighting terms.
Cloud transmission
attenuates the moon's direct diffuse/specular light (95% maximum strength).
A local sky-visibility approximation also reduces ambient/diffuse environment fill
by up to 65%, environment specular by up to 35%, and in-water scattering by up to
75%, weighted by that same transmission. This makes passing shadows legible in
the night scene where indirect illumination otherwise masks them. It is not a
hemispherical sky-occlusion integral. Direct lamp lighting and emission remain
unchanged. Terrain, trees, submerged objects
and the water's analytic moon highlight share it, including reflection captures.
The existing reflected sky already contains cloud occlusion. This approximation
assumes receivers below the cloud base and does not add volumetric light shafts
or shadows to the decorative distant hills painted inside the sky shader.

## Lifecycle and verification

Wind and captures use the existing simulation clock. Hidden tabs do not advance
it; resuming resets the frame timestamp. Reduced motion captures time zero once
and leaves both clouds and water frozen, including after resize. Float-target
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

The final `pnpm check` and `pnpm e2e` runs pass 14 unit tests and 26 browser tests.
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
