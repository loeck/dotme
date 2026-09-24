# Atmosphere

The artistic solar clock supplies sunlight, moonlight, sky color and local-light intensity.
Clock speed affects the solar cycle only. Wind, rain, water and wildlife retain their own
physical time steps. Reduced motion freezes the initial atmosphere while allowing resize
and visibility refreshes.

A seeded shared wind field drives cloud displacement, water waves and environmental
motion. Cloud bodies and procedural noise derive from the world seed. Day/night lighting
and cloud transmission are expressed with TSL nodes rendered through WebGPU.
Terrain shadow layers preserve independent visibility for shadow and main passes.

Profile contrast samples the rendered backdrop through the composition pipeline. The DOM
retains text, links, keyboard focus and screen-reader semantics. Cursor light is a subtle
nighttime effect; pointer interaction remains available in daylight.

The atmosphere is an artistic raster approximation. Indirect light, scattering and local
reflections do not constitute a physical weather simulation. Validate changes with seeded
clear/cloudy day and night captures, reduced motion and resize. See
[verification methodology](performance.md) for browser and GPU commands.
