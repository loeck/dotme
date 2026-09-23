# Calm lake rendering

The React component's public interface is unchanged. `?seed=9182` reproduces the bank,
submerged relief and stones. World units are treated as metres for the optical and wave
parameters; the landscape remains a stylized, nocturnal voxel scene.

## Simulation

`WaterSimulation` exposes `step(seconds)`, `addImpulse(x, z, radius, velocity)`, `reset()`,
`dispose()` and `texture`. Two RGBA16F targets store height (R, metres) and vertical velocity
(G, metres/second). B/A are unused. Resolution is 1024² on desktop, 512² below 768 CSS pixels
at mount. The domain is fixed at x=[-80,80], z=[-112,48], independent of camera movement.

A five-point Laplacian updates velocity, followed by semi-implicit height integration.
The physical step is 1/60 second; propagation speed is 2.4 m/s. The Courant numbers are
0.256 (desktop) and 0.128 (mobile), below the two-dimensional limit 1/sqrt(2). The accumulator
executes at most four steps per call and drops excess wall time. Background-tab recovery
resets the frame timestamp, preventing a backlog. Velocity damping is exp(-0.65 dt).
An 8.8-metre perimeter sponge additionally damps both height and velocity.

A conservative 512²/256² shore raster comes from generated terrain voxel footprints,
including foreground stones and isolated rocks. Solid neighbors substitute the center height
(no-flux reflecting boundary). Cosine splats add local velocity without reading the target
being written. Their support is at least two simulation cells. A bounded queue (128 splats)
and emergency height/velocity limits (±0.22 m, ±1.5 m/s) prevent pathological input from
exploding the field. Ordinary motion stays well below those limits.

The analytic swell uses wavelengths 18, 7, 1.4 and 0.65 m, amplitudes 16, 8, 2 and 0.8 mm,
and deep-water dispersion omega=sqrt(9.81 k). Fragment derivatives suppress wavelengths
smaller than their pixel footprint. Geometry is concentrated around the near lake. Vertex
displacement and fragment normals sample the same height function; fine geometry is still
an approximation of the fragment field. Surface waves model a calm lake, without breaking
waves, spray, volumetric splashes or a full fluid solver.

## Bottom and optics

A deterministic chamfer distance from the rendered banks creates shallow shelves, seeded
relief and a maximum 7.5 m depth. Submerged stones follow that field. The bottom and existing
scene lights render through camera layer 1 into a top-down color/depth target (1024² desktop,
512² mobile). Linear half-float color preserves the dark gradients. A half-float depth field
provides world-space bathymetry for refraction; it requires no float render-target support.
The bed is excluded from the primary and reflection cameras (layer 0).

Pass order is simulation → submerged color/depth → planar reflection (the Reflector's
before-render callback) → main color/depth → depth of field. The bed camera inverse reconstructs
bottom positions. Snell refraction uses n=1.333; four fixed-point iterations against the
bathymetry estimate the submerged intersection. Projection into the top-down bed pass supplies
color and resolved depth, without the disocclusion bands of a grazing camera capture. Schlick Fresnel uses F0=0.02037. Beer–Lambert RGB absorption coefficients are
(0.85, 0.42, 0.27) m⁻¹. Reflection, transmission, scattering and lamp specular terms compose
in linear space before the final display conversion. Lamps use the simulated normal and
existing world-space light positions/intensities. There is no cursor light or emissive crest.

Hover gently reduces optical roughness from 0.065 to 0.025 and reduces transmission blur
inside a Gaussian footprint. This is a deliberate interaction concession, not a physical
change to water depth. Absorption and grazing-angle Fresnel remain in force, so the deep
lake cannot become transparent. Refraction uses a height-field intersection and a projected bed capture; it is single-interface
and approximate:
there is no ray-traced self-occlusion, multiple scattering or caustic pass. Invalid bottom
samples use the deep-water scattering color. Reflections are planar and distorted by the
height-field normal; they do not trace individual displaced wave surfaces.

## Input and lifecycle

Only actual client-coordinate motion generates a wake. Both ends of a stroke are reprojected
with the same camera; interpolated screen samples check visibility along the stroke. Velocity
and travelled distance set the splat energy. Holding still stops injection; pointerdown adds
one impulse and dragging increases strength. Dragging has no separate camera control.

Picking iterates the analytic surface height and asynchronously reads GPU height on pointer
movement. CPU picking uses the most recent GPU sample between reads; very steep fronts can
therefore have a small picking error. A conservative height raster rejects occluding solids
(including tree silhouettes), and `elementFromPoint` excludes UI. The raster can reject thin
areas beneath tree canopies; it deliberately favors avoiding disturbances on solid scenery.
Touch reveals water only during contact. Exit, cancellation, capture loss, blur and visibility
changes clear input history. Asynchronous reads are invalidated at teardown.

Reduced motion renders one static frame (and rerenders on resize), with no simulation steps,
input impulses, parallax or animated introduction. Unsupported float render targets use a
zero state texture and analytic swell; depth/reflection targets use 8-bit color in that mode.
GPU waves are unavailable in this fallback. Every target, texture, geometry, material, listener
and animation frame is released on disposal. The existing context-loss path keeps the profile
available if WebGL itself fails.

## Verification

`pnpm check` runs type checking, lint, formatting, unit tests and the production build.
`pnpm e2e` exercises the production page in Chromium and portrait WebKit, with a separately
bundled test harness for reading real GPU state and inspecting input behavior. It checks
propagation, damping, barriers, finite values, reset, 30/60/144 Hz equality, static input,
UI exclusion, reduced motion and float-target fallback. The harness is served only through
Playwright routes and is not part of the application bundle.

The visual test saves rest/wake screenshots and attaches median/p95 animation-frame intervals.
On macOS Chromium uses ANGLE Metal: headless Chromium defaults to SwiftShader, which makes
the pre-existing full desktop landscape too slow for a useful hardware performance comparison.
Portrait WebKit is an emulated viewport on the development Mac, not a physical iPhone.
Hardware acceptance remains 60 fps desktop / 30 fps mobile; validate on actual target devices
with the same seed, viewport, DPR, motion preference and pointer sequence. Frame interval
samples include browser scheduling and are not GPU timer-query measurements.

Measured on the same development Mac on 2026-09-23, seed 9182, with animation enabled.
The baseline sampled 90 steady-state frames after a 3-second warmup; the final production-page
check sampled 30 frames after its warmup:

| Browser / viewport                  | Before median / p95 | After median / p95 |
| ----------------------------------- | ------------------- | ------------------ |
| Chromium, ANGLE Metal, 1280×720     | 16.7 / 16.7 ms      | 16.7 / 16.7 ms     |
| WebKit, iPhone 13 viewport, 390×664 | 17 / 18 ms          | 17 / 18 ms         |

These runs reach the browser's roughly 60 Hz presentation limit; they do not establish GPU
headroom or physical-phone performance. An additional 90-frame comparison bundled the previous committed engine and the initial
implementation separately with identical camera, seed, viewport and warmup settings; both
reached the same presentation limit. The table above includes the final optical corrections.

## Sources

- [Evan Wallace — water simulation](https://github.com/evanw/webgl-water/blob/master/water.js):
  inspiration for alternating height/velocity textures and propagating disturbances.
- [Evan Wallace — renderer](https://github.com/evanw/webgl-water/blob/master/renderer.js):
  reflection/refraction separation. This implementation is independently written for Three.js.
- [GPU Gems, chapter 1](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models):
  summed wave fields, wavelength-dependent speed and consistent surface derivatives.
