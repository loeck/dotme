# Living lake details

Five procedural additions share the engine's simulation clock, wind, seed and
pointer input. They add no assets, dependencies, point lights or full-screen
render passes. `SceneDetails` owns their resources; construction, update and
disposal are handled by `VoxelLandscapeEngine`.

## Appearance and budgets

| Effect    | Implementation                                                                                            | Desktop / mobile budget                      |
| --------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Caustics  | Filtered moving light folds on submerged ground; modulates existing illumination, preserving shadows      | Material hook, no extra draw or sampler      |
| Wet banks | Upward faces darken and become smoother during rain; moisture remains after rain stops                    | Material hook, no extra draw or sampler      |
| Fish      | Small stepped voxel bodies, vertical tails, muted silver flanks; coherent shoal travel                    | Up to 18 / 10 fish, three instanced batches  |
| Fireflies | Amber shoreline colonies pulse and smoothly retreat from the pointer; daylight and rain reduce visibility | Up to 48 / 18 particles, one instanced batch |

Placement can produce fewer instances when a seed lacks suitable space. Each shoal's
whole route is validated against water, depth and terrain clearance, including its
formation and bounded pointer avoidance. Desktop has three groups of 4, 6 and 8;
mobile has up to two groups of 4 and 6. Seeded ordering and subtle body-size differences
vary their appearance. Synchronized, staggered passage windows keep only one group
clearly visible at a time, with quiet intervals as they recede into the water.
Routes now require at least 1.65 units of water depth. Individual cruise depths vary
from about 1.4 to 1.8 units, with clearance above the highest nearby bed relief.

Fish vertices use an analytic Snell projection into the water surface on camera layer 3.
Only the primary camera includes this layer. Alpha combines depth, rain clarity,
surface Fresnel and passage visibility; warm color channels attenuate faster underwater.
The surface remains visible through each silhouette, with wave normals modulating
transmission. Bank depth testing remains enabled, but fish never write depth.
This is a stylized optical composite, not full volumetric refraction. It preserves small
silhouettes without reconstructing them from the coarse submerged depth/color atlas.
The bed uses the existing 1024/512 oblique capture. Rain reduces underwater clarity;
wind and rain roughen the surface. Clouds change lighting, not water quality.

Local mist billboards are no longer instantiated: their elongated silhouettes produced
horizontal bands even after softening their contact with the lake. Distant volumetric
atmosphere and haze remain part of the main renderer.

Planar reflection ray offsets are bounded to 2–8 metres to avoid stretching bank
texels into long bars at grazing angles. The reflection target uses mipmaps and
up to 8×/4× anisotropic filtering (desktop/mobile, limited by GPU support).
Wave filtering estimates pixel coverage on a flat reference plane so displaced
triangle boundaries cannot change its detail level. Bed color varies smoothly
in world space rather than alternating between grid vertices. The separate
decorative stone batch is removed: its dark sides looked like floating patches
in the oblique capture. The continuous lake-bed relief remains.

Fish geometry uses stepped boxes with vertical forked tails and lateral fins, muted
silver tops and darker flanks. Seeded proportions and tail phases vary by individual.
The shared route, delayed turns and loose formation produce coherent travel, without
claiming a full biological or boids simulation. Pointer proximity uses the apparent
refracted surface position and a bounded, smoothed offset before the group reforms.

Fireflies use a 70-CSS-pixel proximity radius projected through the main camera.
Each particle has a bounded critically damped response, preserving velocity on
entry, exit and reversal. Terrain picking no longer drives this interaction,
preventing jumps when the pointer crosses a bank or the horizon. The resulting
world positions are reused by every reflection camera.

Caustics use the analytic curvature of five short waves from the surface's
shared spectrum, including their phases, envelopes and wind response. Their
convergence gain remains a stylized approximation, not photon tracing or a
solution derived from the fluid solver. There is no independent drifting noise
field. Wetness uses
surface orientation and elevation, not a rain-occlusion simulation or puddles.
Fireflies do not add point lights.

## Rain and daylight integration

The engine supplies the current rain intensity and solar daylight weight each frame.
Explicit overrides remain available for controlled comparisons and do not fetch data:

```ts
engine.setDetailEnvironment({ rainIntensity: 0.65 })
engine.setDetailEnvironment({ daylight: 0.8 })
```

Both overrides are normalized to 0–1 and can be supplied initially
through `detailEnvironment` in the engine options. Partial updates preserve
the other value, non-finite values are ignored and finite values are clamped.
`daylight` changes the details' response; it does not replace the solar lighting
system or change the sky itself.

Inputs without an explicit override follow the live rain and solar state.
`SceneDetails` reuses the shared wind and is created before the global cloud/cursor
material traversal. Its material hooks are attached after that traversal, and its
state updates before environment/reflection/submerged captures. Cloud material
hooks apply to the submerged bed. Cursor-driven caustic illumination is limited
to dark scenes; fish keep their independent pointer response.
The details import neither React nor the weather API, so the static-site
migration does not require replacing these modules.

Rain approaches saturation with an eight-second time constant; dry weather
drains moisture with a 160-second time constant. This exact exponential update
is independent of the step size. Reduced motion freezes simulation, wind
deformation and pointer repulsion. Explicit weather changes set wetness
immediately instead of animating it; light-state updates still redraw.
Hidden tabs inherit the engine's pause behavior.

## Validation

Unit tests cover wetting/drying, frame-rate equivalence, material composition,
seeded placement, underwater boundaries, pointer responses and reduced motion.
The browser harness exercises the complete engine, shader compilation, rain
input, resizing, disposal and frozen-frame comparisons on desktop Chromium and
the mobile WebKit profile.

```sh
pnpm check
pnpm exec playwright test e2e/scene-details.spec.ts
```

Engine option `sceneDetails: false` disables the complete layer for controlled
A/B checks. It is an internal inspection option, not a new visitor control.
Compare identical seed, viewport, motion preference and lighting; a mobile
browser profile on a desktop computer is not a physical-phone performance test.

## Water reflection reconstruction

The planar reflection stores local scenery coverage in its alpha channel; the
sky writes zero only during that capture. Sky samples use the
reflection direction in the existing PMREM environment; nearby scenery retains
its planar parallax. This avoids projecting the infinitely distant sky as nearby
geometry and then adding a second cubemap distortion, which produced angular
patches. Five weighted taps filter local reflections in both axes. The
reconstruction does not blur the underwater capture or fish silhouettes.
The existing shallow-water reveal also limits reflection coverage near the bank,
so the smoother sky reflection does not obscure small fish on mobile screens.

Environment roughness is bounded at 0.09 on desktop and 0.12 on mobile to avoid
magnifying the 128/64-pixel cube faces. The fallback without floating-point
simulation retains the raw environment. Reusing the existing alpha channel keeps
the shader within WebGL2’s minimum of 16 fragment texture samplers, including
scenes with seven shadow-casting lamps.
