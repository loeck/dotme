# Atmosphere

The artistic solar clock supplies sunlight, moonlight, sky color and local-light intensity.
Its orbit runs from the live weather's sunrise to its sunset (06:00–18:00 without live data),
starting at the weather location's local snapshot time unless `startTime` overrides it.
Without `startTime`, a visit opens on the latest golden hour instead (the sun about 8.5° up,
5.5% of the day arc after sunrise or before sunset), holds it for 4 s and time-lapses forward
to the real local time, landing there 22 s after the first frame (`introGap` in
`solar-clock.ts`, quintic easing at both ends). A late-evening visit therefore watches the sun
set and the stars come out; a visit already within ten minutes of that opening is not replayed.
The intro restarts at the first presented frame, so loading never uses up the opening; reduced
motion and an explicit `startTime` skip it. Clock speed affects the solar cycle only. Wind, rain, water and wildlife retain their own
physical time steps. Reduced motion freezes the initial atmosphere while allowing resize
and visibility refreshes.

## Sky and twilight

The daytime sky follows Hillaire, _A Scalable and Production Ready Sky and Atmosphere
Rendering Technique_ (EGSR 2020), with the paper's Earth parameters: Rayleigh and Mie
scattering, a tent-shaped ozone layer and a 0.3 ground albedo (`atmosphere-physics.ts`).
`SkyAtmosphere` renders three half-float LUTs with TSL fullscreen passes:

- transmittance (256×64) and multiple scattering (32×32), drawn once;
- a sun-relative sky view (192×108, 128×72 on low-power devices), redrawn whenever the
  sun moves. Its latitude mapping concentrates texels at the horizon.

Sunsets, the Earth's shadow, the Belt of Venus and the blue hour are therefore emergent
rather than painted. The sky material, distant ridges, horizon mist and the main view's
volumetric air all sample the same LUT, so the horizon behind terrain takes the sky's own
light in each direction. The solar disc uses Frostbite limb darkening, and Sæmundsson
refraction raises and flattens it near the horizon.

CPU lighting uses the same model. Direct sunlight is the atmospheric transmittance at the
viewer; cloud decks sample it at 2 km, keeping their afterglow once the ground is in
shadow. Sky irradiance and horizon radiance, which require multiple scattering, come from
`atmosphere-table.ts`. Regenerate it with `node scripts/atmosphere-table.ts && pnpm fmt`
after changing `EARTH`. A partial exposure adaptation (square root of the irradiance
ratio, capped at 48×) keeps twilight dim but readable; it applies to daylight sources,
never to moonlight or lamps.

## Weather and composition

A seeded shared wind field drives cloud displacement, water waves and environmental
motion. Cloud bodies and procedural noise derive from the world seed. Day/night lighting
and cloud transmission are expressed with TSL nodes rendered through WebGPU.
The cloud volume is captured at 15 Hz on desktop and 10 Hz on low-power devices, into a cube of
384 texels a face on desktop (256 before: at 1600 px across, one texel spread over nine pixels
and every cumulus edge blurred) and 128 on low-power devices. A
separate upper-sky texture records cursor passages while the left mouse button is held; the cloud
volume uses it to erode density with a noise-warped edge during capture. The texture is
anchored to world directions, so openings survive camera motion. Each texel heals on its own
clock, closing about three seconds after it was drawn, so older passages refill while new ones
stay open; releasing the button, leaving the sky or the canvas only ends the current stroke.
Reduced motion clears it.
Cloud transmission samples the opening at the actual cloud crossing of each light ray.
Direct shafts appear only when a passage also crosses the sun or moon direction.

## God rays

The air (`volumetric-light.ts`) is raymarched at half resolution through the sun's shadow map,
which the trees' cards cast into, so their shadows cut beams through lit air. Three things make
the beams read:

- samples crowd toward the eye (quadratic spacing over up to 240 m, 32 on desktop and 16 on
  low-power devices), where beams between the trees are a metre or two across, and each pixel
  starts at its own interleaved-gradient offset; the composite's depth-aware 3 × 3 tent turns
  that jitter into continuous beams instead of step bands, without bleeding air across
  silhouettes;
- a fine aerosol near the ground and the water (pollen, dust, humidity: 0.0013 /m by day, a
  quarter more at golden hour, thinning upward over about 14 m and none under overcast) scatters
  the sun into beams but adds only a fifth of its share of sky light, so it does not grey the
  air;
- when the sun is in or near the frame, screen-space crepuscular rays march 20 depth samples from
  each pixel toward its disc. Open sky along the way streams light through canopy gaps finer than
  the shadow map resolves. The light follows a tight forward lobe (cos⁶⁰, half strength about 9°
  from the disc, plus 5% of cos⁶) and is
  weighted toward partly blocked lines (between branches, at ridge edges), since fully open sky
  already carries the sun's glow; it grows with the air in front of the pixel, up to about 120 m,
  and the sky itself takes a third. A first version with a wide lobe and uniform weight veiled
  the whole golden-hour frame in milk.

At noon the sun stands behind the camera, so the screen-space rays are skipped. On the host GPU
(WebGL 2, 1280 × 720) the atmosphere pass measured 1.3–1.6 ms with or without the rays, as before
the change.
Terrain shadow layers preserve independent visibility for shadow and main passes.

Profile contrast samples the rendered backdrop through the composition pipeline. The DOM
retains text, links, keyboard focus and screen-reader semantics. Cursor light is a subtle
nighttime effect; pointer interaction remains available in daylight.
The pointer ray stops at the first solid: the colliders (ground, cliffs, boulders) or a tree
or shrub's crown, which has no collider and is picked as a stack of spheres following its cards
(one per 0.8 m band). So the light falls on the crown under the cursor, a crown in front of the
water or the waterfall hides them from the pointer, and pointing at a crown against the sky
does not reach the clouds.

## Cursor

With a fine hovering mouse the native cursor gives way, once the landscape is ready, to a
6 px light point with an ink edge (`scene-cursor.ts`); the same point is drawn by an inline
native cursor until then, and on blur, so the hand-off is invisible. Its position is applied on
every event and never eased. Only its shape moves: a trailing point follows the pointer with a
42 ms exponential lag (`cursor-motion.ts`), and their separation stretches the point into a
tail behind the motion, up to 2.1 times its length at area-preserving width, while its leading
edge stays on the hit point. The stretch grows with speed rather than snapping on at a crawl,
eases back by itself when the mouse stops and turns continuously when it reverses. Frames
advance the trail, taking the pointer to move linearly between them, so neither the event rate
nor the display rate changes the shape. Over links and buttons the point shrinks and opens into
a hollow 22 px ring that drifts at most 4 px behind it, so the label under the cursor stays
legible. A press tightens the point (and the ring), and a press on the landscape releases one
faint echo ring that widens and fades in 0.6 s, like the ripple the water answers with.
Reduced motion keeps the hit point and the ring state but drops the stretch, the drift and the
echo; touch and coarse pointers keep their native behaviour.

At night the cursor carries a lantern. The surface under it receives a soft pool of
irradiance (`pointer-light.ts`); when the cursor crosses a silhouette and the surface beneath
jumps in depth, the pool rekindles there instead of teleporting at full strength. Water is
almost purely specular and barely shows that diffuse pool, so the lake shader also reflects a
small lantern hanging 35 cm above the point: a glint just below it on screen that the waves
break into a short shimmering streak, the way the bank's lamps reflect. It is a few
instructions in the existing water material, with no extra pass.

The ground is a smooth heightfield with limestone boulders, shaded by a layered, texture-free
material (meadow grass, buttercups, rough grassland, litter, soil, limestone, far canopy, gravel,
wet mud) whose octaves fade before they
alias; see [terrain](terrain.md). The probe lights flat ground from the bright zenith, but a steep
face samples the dark horizon of islands and water, so a sky fill adds ambient-tinted irradiance,
through the diffuse BRDF and occlusion, peaking on vertical faces (`terrain-detail.ts`).

The sun's day arc keeps both ends in frame, rising over the right ridge and setting over the left
cliffs, but through the middle of the day it swings round behind the camera's right shoulder
(`MIDDAY_SWING`, about 130° at noon, weighted by the square of the arc's sine): the woods,
meadows and limestone then face it in three-quarter light, as in summer reference footage,
instead of reading as back-lit silhouettes. Elevation is unchanged. The fixed camera faces the
low sun at both ends of the day, so the golden-hour look
(`scene-look.ts`) lifts saturation, contrast and warmth but keeps noon's exposure, haze
start and air density (5% thinner), with only a 10% lift of the forward glow. A thicker,
nearer haze there washed the islands and banks into one milky plane against the light.

The base grade keeps saturation at 0.97 and contrast at 1.1 (0.9 and 1.06 for the boreal
shore), with thinner, later haze (×1.45 from 28 m, against ×1.8 from 22 m): a temperate summer
day reads as clear air over saturated, lush greens. With the sky light and tone mapping already
desaturating sunlit foliage, a lower saturation turned crowns and grass grey-green.

Clouds add a second, softer extinction octave to their sun transmittance (Wrenninge's multiple
scattering approximation) and a higher ambient floor, so a cumulus's shaded base is a light grey
rather than the slate of single scattering. Partly cloudy skies draw their bodies at 80% scale:
separate fair-weather cumulus over a clear blue sky. Each body sits on a flat base (its lower
half squashed 1.9 times) and domes upward; fine erosion bites hardest at the rim, so the edge
breaks into rounded turrets while the core stays solid, and a steeper density ramp keeps the
rim crisp.

The visible clear sky is deepened as a polarising filter photographs a summer sky: overhead
about 38% darker and 35% more saturated, near the horizon 14% darker and 12% more saturated, so
white cumulus stand out against a deep blue as in reference footage. Only the sky the camera and
its reflections see changes: scene lighting reads the atmosphere's LUTs directly.

The lens (`depth-focus.ts`) blurs the far ridges by up to 1.35 pixels beyond 90 m and the near
bank by at most 0.6 pixels within 4–14 m, as a lens focused tens of metres out at a moderate
aperture would; a stronger near blur smeared the fine grass blades into fur. The scene draws
without MSAA, so the lens first antialiases the centre sample (FXAA, Lottes's console variant, on
display-compressed luma): alpha-tested leaves, grass blades and twigs otherwise stepped on 1×
screens. It measured within the noise of the lens pass (about 0.5 ms).

The lens then adds bloom (three's `BloomNode`, five blurred mips at half the drawing buffer, a
quarter on low-power devices) to the graded radiance before tone mapping. Its bright pass is a
soft knee (Karis) whose width is half the threshold, on the brightest channel, with the input
capped at 24 so the sun's half-float disc halos without flooding the frame. The threshold sits
at 1.1 graded units by day, so only the sun, its glitter, the waterfall's foam and lamps pass;
golden hour strengthens the glow by a third, and night lowers the threshold to 0.3, where
dark-adapted eyes see haloes round lanterns and fireflies. A fixed knee at night let the whole
frame into the bright pass and veiled it. The grade also split-tones around middle grey: shadows
lean teal and highlights warm, each tone normalised to unit luminance so only hue moves; golden
hour strengthens it by half.

Indirect terrain light, local reflections and weather remain artistic approximations.
Validate changes with seeded clear/cloudy captures at noon, sunrise (`startTime=06:00`),
civil twilight (`05:45`, `18:10`) and night, plus reduced motion and resize. See
[verification methodology](performance.md) for browser and GPU commands.
