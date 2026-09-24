# Living lake details

Six procedural additions share the engine's simulation clock, wind, seed and
pointer input. They add no assets, dependencies or point lights. Fish use a dedicated
capture packed above the bed in the existing color/depth target. `SceneDetails` owns their resources; construction, update and
disposal are handled by `VoxelLandscapeEngine`.

## Appearance and budgets

| Effect    | Implementation                                                                                            | Desktop / mobile budget                                    |
| --------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Caustics  | Filtered moving light folds on submerged ground; modulates existing illumination, preserving shadows      | Material hook, no extra draw or sampler                    |
| Wet banks | Upward faces darken and become smoother during rain; moisture remains after rain stops                    | Material hook, no extra draw or sampler                    |
| Fish      | Tapered faceted bodies, articulated vertical tails, thin fins; coherent shoal travel                      | Up to 26 / 15 fish, three instanced batches                |
| Splashes  | Short-lived breaking water sheets, rounded spray, ballistic return ripples                                | 320 / 144 drops plus 24 sheet slots, two instanced batches |
| Fireflies | Amber shoreline colonies pulse and smoothly retreat from the pointer; daylight and rain reduce visibility | Up to 48 / 18 particles, one instanced batch               |

Placement can produce fewer instances when a seed lacks suitable space. Each shoal's
whole route is validated against water, depth and terrain clearance, including its
formation and bounded pointer avoidance. Desktop has four groups of 8, 5, 7 and 6; mobile has three groups of 6, 4 and 5.
Seeded ordering and subtle body-size differences vary their appearance. Independent 38–62 second
passages allow one, two or more visible groups. Alternating routes and deeper departure dives
keep arrivals and exits distinct. Routes now require at least 1.65 units of water depth. Individual cruise depths vary
from about 1.4 to 1.8 units, with clearance above the highest nearby bed relief.

Fish occupy camera layer 3, which the main and reflection cameras explicitly exclude.
A separate perspective capture preserves their lit silhouettes and depth in a region above
the oblique bed capture, using the same color/depth samplers. Vertex projection uses Snell's
law (n=1.333), extending each viewing ray beneath the interface to an apparent depth rather
than drawing a surface proxy over the water. Transparent passage fades discard zero-alpha
fragments and write depth for fish-to-fish occlusion.

The water shader reconstructs fish depth, applies Beer–Lambert attenuation and scattering,
and composites their premultiplied light with the bed **before** reflection, direct-light
highlights and foam. Wave normals perturb the capture lookup. The material cannot draw a
fish on top of a moon glint. A browser regression makes the interface fully reflective and
checks that toggling the fish then changes zero visible pixels.

This is a single-interface approximation, not ray-traced volumetric refraction. The bed
keeps its 1024/512 oblique capture; the fish region follows the viewport aspect ratio with
width capped at 1600/960. Rain reduces clarity; wind and rain roughen the surface. Clouds
change lighting, not water quality.

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

Fish geometry uses an eight-sided tapered body, thin swept fins and a forked
vertical tail. Three nested GPU joints articulate the body, rear body and tail,
with a stable head and increasing, delayed tail amplitude. Vertex normals follow
the same joint rotations. The rig preserves the existing three instanced draws.
Measured travel speed controls beat frequency; individual effort cycles soften
strokes into glides. Heading follows actual displacement with damping and a
2.5–3.5-radian/second turn limit, slight banking and body curvature in turns.
The formation independently contracts and expands inside its validated corridor.
This is guided schooling, not a full boids or hydrodynamic simulation.
References: [body-wave propulsion](https://doi.org/10.1126/scirobotics.aax4615) and
[Reynolds’ separation, alignment and cohesion](https://www.red3d.com/cwr/boids/index.html). Pointer proximity uses the apparent refracted surface position. It steers forward
velocity with a bounded turn rate and acceleration: fish turn before accelerating,
then route attraction reforms the group. Each proposed step checks the whole body
against dry/shallow terrain. There is no lateral position offset on hover.

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
`SceneDetails` reuses the shared wind and is created before the global cloud
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

The rig compensates for the slender instance aspect ratio before applying joint
rotations; otherwise scaling compressed tail beats until the fish appeared rigid.
GPU probes verify the anchored head and moving tail, and an in-scene comparison
freezes travel to ensure articulation remains visible at the real camera scale.

## Wind-driven impacts

Shore candidates come from the signed distance to actual block footprints, with normals
pointing into water. Every 0.1 seconds the controller samples the same analytic wind-wave
height and upward velocity as the surface. Only rising crests on windward faces qualify;
wind below 1.7 m/s produces no spray. Seeded probability, cooldowns and crest rearming make
impacts intermittent. This is a procedural impact approximation, not a 3D fluid solver;
the GPU's local interaction ripples do not independently trigger spray.

A briefly translucent upwash rises along a wet portion of the block and tears into thin
strands over 0.18–0.31 seconds. It curls outward and breaks before the apex, instead of
tracing a continuous arch from a single emitter back to the water. Each event slides to
a different position along the struck face; the signed shore field rejects solid origins
and incompatible corners. The sheet width contracts to fit the contiguous wet face.
Each impact samples an immutable procedural profile: fan width and lean, lift, reach,
jet count and spacing, emission duration, breakup timing and hole pattern all vary.
Random values are sampled once per event, so the shape animates continuously without
frame-to-frame random jitter. Replaying the same seed and simulation inputs reproduces
the same shapes; wind exposure and crest energy still control whether an impact occurs
and its strength.
Smooth instanced ellipsoids detach from distributed positions along that face with
independent ejection speeds, heights and delays. Fine spray follows the wind more quickly
than larger drops through size-dependent air drag. Closed-form drag trajectories let the
landing solver evaluate positions inside a frame without numerical stepping. Drops stretch
along velocity and round near the apex. They disappear at solid contact or
water return. Every descending drop detects its return against the moving analytic wave surface, with
seven bisection steps locating contact within the frame. Each wet landing contributes a
size- and speed-dependent impulse to the water simulation. Close landings within 0.1 seconds and 22 cm of space combine their energy into a common surface
packet, avoiding stacks of identical rings.

The detail wave packets add signed world-space slopes and unresolved variance to the
existing rain normal buffer. The lake uses them for reflection, refraction, direct-light
highlights and roughness. Brief irregular bubble patches use that buffer's alpha channel
and the water's existing foam lighting. There is no extra texture sampler or full-screen
pass, and no opaque white ring drawn over the water. Strong contacts also lift a translucent,
scalloped 3D water crown with variable radius, lobe count and a 0.22–0.34 second lifetime;
wave packets decay within 1.35 seconds.
The bounded 128/64 impact pool draws only active instances and is excluded from reflection
and underwater captures. The shared normal buffer clears after the final impact even when
rain is disabled; dry frames with no remaining impact skip that pass.

Shore jets emit staggered droplets along two to six related trajectories, with a variable
0.06–0.22 second emission window and individual jet delays. Their
initial height follows the wave at emission time. Water sheets tear with irregular holes and
threads instead of evenly spaced stripes. Contact selection prioritizes visible near shores,
using the terrain height raster to avoid spending most of the budget behind ridges; windward
crest qualification remains unchanged. The CPU landing contact uses analytic wind waves,
without synchronous GPU readback for local ripples. Reduced motion disables all impact motion.
All resources are disposed with the scene.

The separation of surface water, breakup and secondary particles follows the production
principles described in [Moana: Performing Water](https://media.disneyanimation.com/uploads/production/publication_asset/163/asset/Moana-_Performing_Water.pdf)
and [NVIDIA WaveWorks](https://developer.nvidia.com/blog/?p=28941), adapted here to a small
real-time particle and sheet budget rather than their fluid simulation systems.
