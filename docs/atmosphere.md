# Atmosphere

The artistic solar clock supplies sunlight, moonlight, sky color and local-light intensity.
Its orbit runs from the live weather's sunrise to its sunset (06:00–18:00 without live data),
starting at the weather location's local snapshot time unless `startTime` overrides it.
Clock speed affects the solar cycle only. Wind, rain, water and wildlife retain their own
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
The cloud volume is captured at 15 Hz on desktop and 10 Hz on low-power devices. A
separate upper-sky texture records cursor passages every displayed frame; the sky
composition uses it to feather both cloud radiance and transmission. The texture is
anchored to world directions, so openings survive camera motion, and each passage
refills in about three seconds after the cursor leaves. Reduced motion clears it.
Terrain shadow layers preserve independent visibility for shadow and main passes.

Profile contrast samples the rendered backdrop through the composition pipeline. The DOM
retains text, links, keyboard focus and screen-reader semantics. Cursor light is a subtle
nighttime effect; pointer interaction remains available in daylight.

Indirect terrain light, local reflections and weather remain artistic approximations.
Validate changes with seeded clear/cloudy captures at noon, sunrise (`startTime=06:00`),
civil twilight (`05:45`, `18:10`) and night, plus reduced motion and resize. See
[verification methodology](performance.md) for browser and GPU commands.
