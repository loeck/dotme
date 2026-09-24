# Leaves, stars and ambient sound

Implemented in the isolated `feat/living-landscape` worktree. Commit `9ecef4f`
snapshots the original dirty workspace, including its untracked source files, before
these additions. No public URL options, runtime service or package dependency were added.

## Floating leaves

`SceneDetails` owns `LakeLeaves`: one instanced mesh and one shared standard material,
with 12 desktop / 6 mobile blades, three proportions and olive/ochre/brown instance colors.
The seed determines placement, scale, heading and circulation phase. Candidates are in
the camera's near lake and tested against terrain occlusion and the signed shore field.
`LeafDrift` is independent of rendering. It integrates at 60 Hz, recovering at most four
steps after an interruption. Weak wind-driven circulation and a broad return current
keep the fixed population in its original visible area. Shore gradients remove inward
velocity progressively; a conservative final clearance check prevents penetration.

Validated moving water-pointer segments feed bounded lateral impulses. UI/terrain hits
are rejected by the existing water picking path; stationary pointer events carry no energy.
Touch uses the same water interaction path. Reduced motion freezes placement and input.

Every blade vertex samples `WATER_FIELD_GLSL`, including the live interaction height and
wind spectrum, with a small clearance for water-mesh interpolation. Face derivatives
produce the tilted lighting normal. Shared uniform objects ensure the leaves receive the
new ping-pong texture immediately after every water simulation update. Analytic fallback
retains the wind field. Cloud shadows, scene lighting and received shadows use the existing
material hooks. Leaves cast no shadows. Layer 0 includes them in the main and planar
reflection views; they are explicitly hidden for the environment probe and excluded from
underwater layers 1 and 3. No new capture or water-fragment sampler is used.

## Stars and shooting stars

The sky shader hashes cells in fixed spherical directions. Points have seeded jitter,
a strongly skewed brightness distribution, warm/cool variation and pixel-filtered energy.
Visibility depends on solar elevation, so cloudy daylight cannot reveal stars. Bright stars
arrive first, with a reversed transition at dawn. Horizon and lunar-halo attenuation keep
silhouettes legible. The contribution is composed before clouds and distant ridges.
The existing environment capture carries filtered stellar light into the lake.

`ShootingStars` counts active night seconds independently of `timeScale`. Seeded intervals
are 90–180 seconds; one short upper-frustum trajectory can be active at a time. Very
covered skies suppress events without queuing missed attempts. Age and scintillation use
active wall time; visibility changes reset the engine's frame timestamp. Reduced motion
freezes scintillation and disables meteors. Environment resolution/cadence are unchanged.

## Sound and provenance

All five author pages were checked for **CC0 1.0** on 2026-09-24. The shipped clips are
excerpts of Freesound's publicly available high-quality MP3 previews. Each original source,
preview URL, author, excerpt offset and shipped SHA-256 is recorded in
[`public/audio/sources.json`](../public/audio/sources.json). Credits also appear in the
information dialog.

| Layer   | Author and source                                                                                      | Excerpt     | Duration |
| ------- | ------------------------------------------------------------------------------------------------------ | ----------- | -------: |
| Water   | [salilnair, Water-lap-against-rocks-lake](https://freesound.org/people/salilnair/sounds/524688/)       | 00:05–00:24 |     19 s |
| Wind    | [Nox_Sound, Ambiance_Wind_Forest_Trees_Loop_01](https://freesound.org/people/Nox_Sound/sounds/530908/) | 00:07–00:30 |     23 s |
| Rain    | [AlanCat, ForestRainShower1a](https://freesound.org/people/AlanCat/sounds/383064/)                     | 00:20–00:41 |     21 s |
| Insects | [Sclolex, crickets](https://freesound.org/people/Sclolex/sounds/210540/)                               | 00:08–00:25 |     17 s |
| Birds   | [VKProduktion, Forest_Birds (loop) 02](https://freesound.org/people/VKProduktion/sounds/231537/)       | 00:04–00:10 |      6 s |

Processing with FFmpeg: mono, 32 kHz, high-pass 100 Hz, low-pass 11 kHz,
`loudnorm=I=-27:TP=-9:LRA=7`, MP3 `libmp3lame` at 80 kbit/s. The mixer schedules
1.5-second linear overlap envelopes on the audio clock, including decoded MP3 padding.
Bird excerpts are spaced by 20–60 active audio seconds. There is no music, thunder,
interface sound or meteor sound.

Audio payload: **864,585 bytes**, below 2 MB. Nominal decoded buffers total **10.5 MiB**
at the requested 32 kHz; browser tests also decode at 48 kHz and check the 24 MiB ceiling.
A runtime guard enforces that ceiling. Clips remain local; no audio request occurs until
activation. The mixer is a separate lazy chunk, independent of Three.js.

The gesture component creates/resumes one context synchronously in the click handler,
then imports and loads the mixer. Base water failure turns the command off with an
accessible retry message; secondary failures retain available layers. Network loads have
a 15-second timeout. Cancellation invalidates pending work and aborts fetches; late decoding
cannot start playback. The scene emits solar hour, daylight, wind speed and effective rain
initially and at most four times per second. Layer gains follow those values with a
2-second smoothing constant; the master fades in over 1.5 seconds and out over 300 ms.

Hiding pauses scheduling, fades down over 40 ms and suspends the context; returning resumes
with a fade when previously enabled. Refused resume turns the command off. Renderer restarts
for motion preference changes retain the context. Pagehide destroys audio; a restored page
starts silent. A landscape failure disables the command. No preference is persisted.

## Verification and limits

- `pnpm check`: TypeScript, lint, formatting, 204 unit tests and production build pass.
- Unit tests cover seeded leaf populations, clearance during strong pushes, fixed-step
  equivalence, bounded recovery, reduced motion, star thresholds/cadence, weather mix,
  delayed decoding/cancellation and three minutes of scheduling.
- Final Chromium/mobile WebKit suite: **97 passed, 1 intentionally skipped** (desktop-only
  pointer-light interaction on mobile). MP3 decoding, budgets, keyboard activation, no pre-click
  requests, cancellable loading, partial failure/retry, visibility, preference changes,
  pagehide/restore, both GPU-masked icons, day/dusk/night/overcast/rain rendering and capture
  membership pass. Existing home, solar, contrast and water-physics suites also pass.
- Captures are stored in `artifacts/living-landscape/visuals`; benchmark and bundle JSON
  are alongside them. See [performance notes](./performance.md) and [bundle sizes](./bundle-size.md).

The actual production mixer was also rendered for three minutes in Chromium and WebKit
OfflineAudioContext: peak <0.25, adjacent-sample step <0.1, and every post-intro one-second
window retains RMS >0.0001 (no silent loop gaps). These numerical checks are not a perceptual listening review. A real
headphone/speaker listen is still required to approve recording content, repetition,
subjective volume and inaudible seams. Mobile WebKit emulation is not a physical iPhone.

## Workspace preservation

All implementation writes and test/build outputs were made under
`/Users/loeck/Workspace/hivebrite/dotme-living-landscape`. The original Git status is
unchanged. A SHA-256 comparison against the initial 146-file snapshot detected concurrent
changes in the original `src/scene/VoxelLandscapeEngine.ts`, `src/scene/pointer-light.ts`
and `e2e/solar-light.spec.ts`; this task did not write those original files or attempt to
restore them. The branch intentionally retains the initial snapshot as its comparison base.
