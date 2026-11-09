# Rain

`RainSimulation` advances world-space droplets at a fixed 60 Hz, matching the engine's frame cap;
streak heads are extrapolated by the unstepped remainder so drops never stall between steps. Water
crossings use Illinois regula falsi on the moving surface. One world unit represents
one metre. Segment/terrain collisions retire drops and create pooled impacts; catch-up and
pool capacities are bounded. Horizontal wind, drop size and emission respond to the weather
state. Reduced motion suppresses rain; hidden pages pause updates.

`RainEffect` translates simulation state into node materials for streaks and surface impacts.
TSL composition handles depth occlusion and the appearance of impact waves on WebGPU. Water collision uses the shared CPU contact sampler, including bounded recent lake impulses,
while visible surface effects follow the GPU wave field. Streak radiance follows the ambient environment
plus moon and lamp glints, since a drop refracts most of its surroundings, and blends into the
scene's exponential fog with distance so far rain reads as haze rather than dark streaks. Streaks
fade out between 3 m and 1.2 m of view depth (including the exposure tail), with projected motion
bounded to 28 CSS pixels, width to 6 CSS pixels and a guarded perspective divide. Drops crossing
the camera plane therefore cannot turn into bright lines across the viewport. The overlay
blends premultiplied colour, since `renderOutput` unpremultiplies its input and premultiplies its
result; straight alpha there darkens the background by the drop's coverage. Streaks are
not reflected by the lake: drop reflections are practically invisible and read as dashes on the water. This is an artistic rain approximation, not
volumetric optical scattering or a fluid solver.

The public rain state accepts intensity in 0–1 and horizontal wind bounded to ±20 m/s.
Non-finite inputs fall back to defaults. Zero intensity clears pending events and avoids
unnecessary simulation work. Disposal releases all owned geometry, materials and targets.

Unit tests cover wind response, deterministic stepping, segment collisions, shelters,
impacts and bounded pools. Browser verification covers rainy scenes and reduced motion; explicit GPU tests validate the node pipeline. Prolonged sampling belongs in
`pnpm benchmark:scene`.

The water shader also supplies a dense background field of small rain rings. Its radial pixel
filter retains impacts across a grazing view, and gradually transfers unresolved rings into
surface roughness. GPU readbacks check that impacts remain distributed across the view on both
WebGPU and WebGL, and that dry weather clears the field.

## Snow

Snowfall (`SceneWeather.snow`, preset `snow`) shares the rain's infrastructure: `RainEffect.setSnow`
drives a `SnowSimulation` (`snow-simulation.ts`) whose flakes are drawn by a fourth particle
material in the rain overlay, with its lighting, depth occlusion, fog and compilation. Flakes of
6–22 mm fall at 0.65–1.35 m/s from 14 m, released over the view like the rain (denser near the
camera), and ride 85% of the rain's wind with a 0.7 s lag, flutter and spiral, swerve round the
cursor's dry pocket and ride the cursor's gusts (`WindGusts.pushAt`, 5 m/s per unit). They vanish
where they meet the ground or the lake, with no impacts, rings or splashes; the ground is cast
once at release and again where a gust carried the flake. Desktop holds 16 000 flakes at full
snowfall, low-power devices 5 000. A flake is a round, matte point lit by the ambient, fog and
direct light (no refraction glints), its size from its diameter, widened by the lens's defocus
near the camera and kept at least a faint dot far away. Reduced motion hides the snowfall, as it
hides the rain.

Snow lies on the scene (`snow-cover.ts`): one shared uniform, 0–1, whitens upward faces of the
ground, the stones (above the waterline and away from the waterfall's spray) and the crowns' upward
cards, the flattest first and steeper ones as it deepens, broken by each material's own grain; it
also flattens the ground's relief and sets a matte roughness. The cover builds at the snowfall's
intensity (75 s of full snowfall for a complete cover), opens at 55% of the square root of the
intensity (the scene arrives mid-snowfall), and melts in about 110 s at 4 °C once the snow stops,
slower in colder air. Reduced motion freezes it.

The rain's programs are compiled in the overlay's own state (onto the canvas, untoned and linear,
against the scene), as `renderOverlay` draws them; compiling them in the scene's toned state built
variants that were never used while the first rainy frame compiled two more.

References: [Garg and Nayar's rain streaks](https://cave.cs.columbia.edu/Statics/publications/pdfs/Garg_TOG06.pdf),
[dynamic rain effects](https://seblagarde.wordpress.com/2013/01/03/water-drop-2b-dynamic-rain-and-its-effects/),
[capillary rings](https://doi.org/10.1017/S0022112088003301).
