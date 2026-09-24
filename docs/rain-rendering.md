# Rain streak appearance

Airborne rain keeps the existing seeded 0.6–4.4 mm diameter distribution, world-space
motion, voxel occlusion and shared water-impact simulation. Intensity changes the
number of drops rather than enlarging them.

Each impact comes from the same tracked drop. Collisions sample the analytic wind
surface used by the lake, resolving the crossing within the fixed simulation step;
the first intersection with solid terrain still takes precedence. The contact stores
its exact position, time, diameter and incoming velocity. The simulation clock is
mapped to the lake clock before each update. Local GPU pointer ripples are not read
back to the CPU collision solver.
The clock mapping includes the fractional time awaiting the next fixed step, so
displays such as 144 Hz sample the same contact surface as 30/60 Hz displays.

For the final 1/90 s camera exposure, a landed drop retains a shortening, fading
incoming streak whose head is the contact point. It joins the ripple rather than
disappearing a frame before impact. Relative kinetic energy (diameter cubed times
vertical speed squared) drives wave strength and duration. Small drops leave brief,
subtle surface ripples; larger drops can form a short translucent crown and one to
three secondary droplets. Ripples decay within 0.45–1.1 s, crowns within 0.13 s. Crown
opacity responds to viewing angle instead of drawing a uniformly bright white rim.

The streak shader projects the actual diameter using half the viewport height
(NDC spans two units). Its length comes from projected velocity over a fixed
1/90 s exposure, independent of frame rate and the accelerated solar clock.
The previous diameter projection was twice too large, while a 1/48 s exposure
and wide near-field defocus further exaggerated the streaks.

Subpixel drops use a Gaussian with a one-device-pixel full width at half maximum
(2.5 pixels of support), with energy compensation for its width. This avoids
losing most of a thin drop's brightness between pixel centres. Its minimum is independent of CSS pixel ratio, so
high-DPI screens resolve thinner streaks instead of magnifying them. A small
defocus footprint applies only within four metres of the camera. There is no
long-distance blur enlargement. Larger/nearer drops remain more visible than
small/distant drops; seeded brightness variations and longitudinal highlights
break up the uniform white-rod appearance. The sun/moon and local lamps still
provide the incident light.

Rain, spray and impact crowns remain in the lake's planar reflection capture.
Before each particle draw, the shader receives the actual active viewport size,
including the smaller reflection target. The pixel ratio for optical defocus scales
with that viewport; the main overlay restores its own resolution on its next draw.
Reflected streaks integrate their physical width across each texel instead of applying
an enlarged Gaussian footprint. Their exposure padding is also only one texel.
This preserves tiny glints between texel centres without broad luminous wisps.
Rain uses a finer, bounded reflection target (up to 1536 × 1080 on desktop); dry
scenes retain the smaller target. Mobile retains the 768 × 832 cap. This costs
additional reflection fill rate while rain is active, but adds no rendering pass.

This prevents a reconstruction footprint measured in canvas pixels from collapsing
between reflection texels. The reflection's premultiplied coverage, water Fresnel
and wave distortion remain in the water composition.

The lake samples the planar image with a single continuous trilinear footprint and
anisotropic filtering at grazing angles. It no longer combines five spaced copies
with an extra mip bias, which scattered isolated reflected raindrops into detached
halos. Mipmap selection still follows the distorted UV derivatives, retaining
antialiasing for terrain reflections. This remains a planar reflection approximation;
it does not trace each drop against the fully displaced water surface.

This follows the perspective, exposure and defocus principles in
[Garg and Nayar, Photorealistic Rendering of Rain Streaks (SIGGRAPH 2006)](https://www1.cs.columbia.edu/CAVE/publications/pdfs/Garg_TOG06.pdf),
whose [rendering pipeline](https://cave.cs.columbia.edu/old/projects/rain_ren/pipeline_algorithm.html)
separates particle motion from the optical appearance of the streak. The current
implementation is a lightweight procedural approximation: it does not implement
their oscillating-drop ray tracing or measured streak texture database.

`e2e/rain-optics.spec.ts` reads real GPU pixels from the production shader to
check that a millimetre-scale drop stays thin, gets shorter/dimmer with distance,
and resolves more finely at high DPI. It also checks contrast on a grey background
at four subpixel offsets, so narrowing the rain cannot quietly make it disappear.
Its nested-render test uses the real `RainEffect` and `Reflector`, verifies nonzero
reflected light and correct viewport uniforms for both passes, then checks identical
pixels after resizing and restoring the initial dimensions.
`e2e/rain.spec.ts` checks the full rain
lifecycle, signed water-normal output, resize and disposal on desktop/mobile.
That isolated fixture disables shore details because shore impacts now share
the rain normal buffer even when rainfall is off.
