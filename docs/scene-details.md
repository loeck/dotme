# Living lake details

Five procedural additions share the engine's simulation clock, wind, seed and
pointer input. They add no assets, dependencies, point lights or full-screen
render passes. `SceneDetails` owns their resources; construction, update and
disposal are handled by `VoxelLandscapeEngine`.

## Appearance and budgets

| Effect    | Implementation                                                                                                  | Desktop / mobile budget                      |
| --------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Caustics  | Filtered moving light folds on submerged ground; modulates existing illumination, preserving shadows            | Material hook, no extra draw or sampler      |
| Low mist  | Thin, depth-tested sheets meet the water surface; water mask clips land and wind advects the noise              | Up to 18 / 8 sheets, one instanced batch     |
| Wet banks | Upward faces darken and become smoother during rain; moisture remains after rain stops                          | Material hook, no extra draw or sampler      |
| Fish      | Distinct carp, roach and perch bodies, vertical tails, curved fins, natural markings and individual proportions | Up to 12 / 6 fish, three submerged batches   |
| Fireflies | Amber shoreline colonies pulse and smoothly retreat from the pointer; daylight and rain reduce visibility       | Up to 48 / 18 particles, one instanced batch |

Placement can produce fewer instances when a seed lacks suitable space. Fish
are confined to fully checked water patches. Their depth follows the bed so
the existing refracted-bottom capture can resolve them. They remain in layer 1;
they are not rendered above the water or in its planar reflection.

The 56-metre near-lake capture uses the existing 1024/512 resolution; it concentrates
the underwater texel density without allocating a larger target. Its edges fade
out in the water shader. The capture looks down at 45 degrees to preserve fish
flanks and vertical tail fins through the refracted view. Shallow foreground water has lower absorption and
narrower texture filtering; hovering reduces the reflected fraction locally so
fish can be discovered through the surface. The distant deep water keeps its
original absorption and reflection response.

Planar reflection ray offsets are bounded to 2–8 metres to avoid stretching bank
texels into long bars at grazing angles. The reflection target uses mipmaps and
up to 8×/4× anisotropic filtering (desktop/mobile, limited by GPU support).
Wave filtering estimates pixel coverage on a flat reference plane so displaced
triangle boundaries cannot change its detail level. Bed color varies smoothly
in world space rather than alternating between grid vertices. The separate
decorative stone batch is removed: its dark sides looked like floating patches
in the oblique capture. The continuous lake-bed relief remains.

Fish anatomy and pigmentation follow the
[FAO common carp description](https://www.fao.org/fishery/docs/CDrom/aquaculture/I1129m/file/en/en_commoncarp.htm)
and [Wildlife Trusts freshwater fish references](https://www.wildlifetrusts.org/wildlife-explorer/freshwater-fish).
Separate profiles distinguish the bronze carp, silver roach and striped olive
perch. Caudal fins are vertical, pectoral fins lateral, with individual seeded
size and cadence variations. Rearward undulation follows the principle in the original
[WebGL Aquarium shader](https://github.com/WebGLSamples/WebGLSamples.github.io/blob/master/aquarium/aquarium.html#L186-L237).

Locomotion uses continuous steering with bounded acceleration and turn speed,
individual propulsion/glide cycles, separation and early turns within checked
water patches. These are animation rules inspired by
[Reynolds' steering behaviors](https://www.red3d.com/cwr/steer/gdc99/), not a biological simulation.
Pointer proximity uses an 85-CSS-pixel radius around each fish's apparent
refracted surface position. Escape builds progressively, retains momentum and
decays after pointer exit; velocity and effort drive the tail and banking.

Fireflies use a 70-CSS-pixel proximity radius projected through the main camera.
Each particle has a bounded critically damped response, preserving velocity on
entry, exit and reversal. Terrain picking no longer drives this interaction,
preventing jumps when the pointer crosses a bank or the horizon. The resulting
world positions are reused by every reflection camera.

Mist sheets start below the water plane, allowing depth testing to attach their
visible foot to the surface. Their total height is 0.25–0.45 metres, with a soft,
irregular upper fringe; only that fringe moves vertically.

Caustics use the analytic curvature of five short waves from the surface's
shared spectrum, including their phases, envelopes and wind response. Their
convergence gain remains a stylized approximation, not photon tracing or a
solution derived from the fluid solver. There is no independent drifting noise
field. Mist uses local sheets rather than volumetric integration. Wetness uses
surface orientation and elevation, not a rain-occlusion simulation or puddles.
Fireflies do not add point lights.

## Rain and daylight integration

This branch still contains the original nocturnal scene. The parallel rain,
solar, performance and static-site worktrees are not merged by this change.
The weather input is explicit, framework-independent and does not fetch data:

```ts
engine.setDetailEnvironment({ rainIntensity: 0.65 })
engine.setDetailEnvironment({ daylight: 0.8 })
```

Both values are normalized to 0–1, default to 0, and can be supplied initially
through `detailEnvironment` in the engine options. Partial updates preserve
the other value, non-finite values are ignored and finite values are clamped.
`daylight` changes the details' response; it does not replace the solar lighting
system or change the sky itself.

When combining the parallel branches, call `setDetailEnvironment` with the rain
effect's active intensity and the solar system's daylight weight. Reuse the
existing shared wind state. Keep `SceneDetails` creation before the global
cloud/cursor material traversal, its material attachment after that traversal,
and its update before environment/reflection/submerged captures. The cloud
material hook composes with previous hooks.
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
