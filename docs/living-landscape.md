# Stars and ambient sound

Seeded stars appear at night and are attenuated by clouds. Reduced motion freezes their
animation and suppresses transient shooting stars.

## Sound and provenance

The field recordings are documented as **CC0 1.0** in the source manifest. The shipped clips are
excerpts of Freesound's publicly available high-quality MP3 previews and BigSoundBank's original
waterfall recording. Birdsong, owls, splashes and music are generated locally with Stable Audio 3
through devbox's generator (Stability AI Community License); the manifest records each take's
model, prompt, seed, job and processing. Each original source,
preview URL, author, excerpt offset and shipped SHA-256 is recorded in
[`public/audio/sources.json`](../public/audio/sources.json). Credits also appear in the
information dialog.

| Layer     | Author and source                                                                                      | Excerpt                         | Duration |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------------------------- | -------: |
| Water     | [TRP, Gentle lapping lake water waves](https://freesound.org/people/TRP/sounds/573163/)                | 00:05–01:05                     |     60 s |
| Wind      | [Nox_Sound, Ambiance_Wind_Forest_Trees_Loop_01](https://freesound.org/people/Nox_Sound/sounds/530908/) | 00:07–00:30                     |     23 s |
| Rain      | [AlanCat, ForestRainShower1a](https://freesound.org/people/AlanCat/sounds/383064/)                     | 00:20–00:41                     |     21 s |
| Insects   | [Sclolex, crickets](https://freesound.org/people/Sclolex/sounds/210540/)                               | 00:08–00:25                     |     17 s |
| Waterfall | [Joseph SARDIN, Mini waterfall](https://bigsoundbank.com/mini-waterfall-s0996.html)                    | 00:01–00:25, circular crossfade |     23 s |

Base clips are processed with FFmpeg: mono, 32 kHz, high-pass 100 Hz, low-pass 11 kHz,
`loudnorm=I=-27:TP=-9:LRA=7`, MP3 `libmp3lame` at 80 kbit/s. Browsers that report Ogg Opus
support load `.ogg` copies instead, encoded from the same unencoded chain with `libopus` VBR at the
lowest rate whose third-octave spectral distance to that chain matches the MP3: 56 kbit/s for water,
insects and birds, 64 kbit/s for the others. Below 56 kbit/s, libopus limits mono to an 8 kHz band.
Each copy is encoded with a per-layer gain, recorded in the manifest, that matches its MP3 loudness.
If an Ogg clip fails to load or decode, the mixer switches to the MP3 clips. The mixer schedules
equal-power overlap envelopes on the audio clock, so overlapping passages of uncorrelated
material keep a constant loudness instead of dipping 3 dB at each join.
Water plays random 24–36 second passages of the 60-second recording with four-second
crossfades and separated start offsets, preserving its natural pitch. Wind, rain, insects and
the waterfall play random passages of half to most of their loop at fresh offsets, so no bed
repeats with an audible period. The clips are mono; each bed plays two independent passages
panned to either side, which widens the field without more downloads or memory. Only the
waterfall stays a single, positioned source. Water gain is
0.14–0.175 in dry weather, ducked by up to 45% in rain; maximum rain gain is 0.42.
The water therefore leaves room for the other layers instead of dominating rain. Rain is heard,
not measured: its gain follows the square root of the intensity (a quarter of the rain plays at
half the level), the water and waterfall duck by the same curve, and a low-pass on the rain bed
opens from 1.2 kHz in a drizzle to 11 kHz in a downpour. Snow silences the rain bed.

Every layer, call, note and peal meets at one master gain of 0.76. That is 6 dB above the 0.38 the
landscape used to play at, which sounded faint next to other pages. The relative levels above are
unchanged. A peak limiter (`DynamicsCompressorNode`: threshold −6 dBFS, 4 dB knee, ratio 12,
3 ms attack, 250 ms release) sits between the master and the output. The beds and calls stay
below its threshold, so it only engages on rare peaks: thunder over a full rain bed, a near
splash, or music over the beds. Those are held under full scale instead of clipping. In the
page's single context, the streamed music shares that limiter. The limiter decodes nothing, so
the decoded-audio budget is unchanged.

The weather the scene does not simulate reaches the sound through `setWeather` on the sound
control (a `SceneWeather` fits): crickets fall silent below about 10 °C (a smooth fade from 8 to
12 °C) and, following Dolbear's law, play 1.2% faster per degree above 20 °C and slower below, from
0.9 to 1.15 times. Fog and snow muffle the landscape: a master high shelf above 2 kHz cuts up to
14 dB and the birds and owls lose up to 60% of their level. The wind bed is placed upwind of the
camera: the engine reports `windPan` (`windPanFromCamera` in `pan.ts`) with each environment
update. The landscape calls `setWeather` with the opening weather and with every live refresh.
Splashes, skip notes and the shockwave's note are panned from the camera's own axes
(`panFromCameraMatrix`), so a source behind the camera keeps its side instead of being mirrored.
The scene also reports how deep in winter its season is (`winter`, 0–1, see
[seasons](vegetation.md#seasons)): the crickets fall silent with it and the birds lose up to 60%
of their level, so a winter visit sounds as thin as its wood looks.

A small synthesised reverb places the calls in the open air: a 2.5-second stereo impulse of
decorrelated, darkening noise with 60 dB of decay (`reverb.ts`), built once per mixer at the
context's rate (640 kB at 32 kHz, counted in the decoded budget). Owls, thunder and skip notes are
sent to it, the music lightly; its return is wetter at night and a little in fog.

| Layer        | Generated takes                                                   | Shipped |
| ------------ | ----------------------------------------------------------------- | ------: |
| Birds        | Northern pine forest birdsong by a lake, 24 s take                |    20 s |
| Owls         | Two owl takes, three call groups transposed down to a tawny owl's |    14 s |
| Splashes     | Two stone splashes, two waves on a stony shore, two single drops  |     8 s |
| Music, day   | Sparse solo felt piano, major key                                 |    90 s |
| Music, night | Soft piano over a low pad, minor key                              |    90 s |

Birds sing 4–8 second phrases at random offsets, positions and slight pitch (±4%) every
9–28 s by day. Keyed on daylight rather than the clock, a dawn chorus packs them into
overlapping song while the morning light comes up, and briefly again at dusk. Owls call
every 35–95 s in a dry, dark night, one of three call groups, never the same twice. Pointer
splashes, breaking waves and droplets falling back into the lake play takes from the splash
sprite, attenuated by distance and panned to their place in the view; drops are thinned to
three a second. Music is occasional: a first piece 30–50 s after sound starts, then 2.5–5
minutes of silence (half as long again in rain), the day piece in dry daylight and the night
piece otherwise. It streams through a media element, so it adds nothing to the decoded
budget and is requested only when due; hiding the page stops the piece. WebKit allows a media
element to start outside a gesture only once it has played inside one, and the first piece is
due long after the click: the enabling click therefore plays a muted tenth of a second of
silence through a new element (`media-unlock.ts`), which the music reuses. A refused piece is
logged once at debug level, exposed as the mixer's `musicState` (`blocked` or `failed`), and
retried after the usual gap. Thunder is described below; meteors make no sound.

### Interaction sounds

Sounds may answer an interaction with the scene, provided they stay sober: quiet, short,
placed where the interaction happens and tuned to the music, never a click or beep on a DOM
control. The buttons, dialog and links remain silent. Today the only such sound is a skipping
stone's note (`skip-notes.ts`): each touchdown rings a soft bell-like tone, a sine with a quiet
octave and a faint twelfth, struck in 6 ms and ringing out over about a second, on top of the
usual splash take. Successive skips climb the major pentatonic of the current mood and the stone
sinks on the root an octave lower. A chromagram of the shipped pieces puts the day piece in
C major (G, B, E and C strongest, F well above F♯) and the night piece in F major (F, C, A and
D), so the notes use C major pentatonic from C5 in daylight and F major pentatonic from F4
otherwise: neither scale holds a semitone against either piece. A long press released as a wave
on the water rings the same low root as a sinking stone, louder for a fuller charge. Notes are synthesised with
oscillators, so they add nothing to the download or the decoded budget; they share the master
gain and mute control, are attenuated and panned like the splashes, and stay silent while
playback is paused or off. A new interaction sound should follow the same rules and be added to
this section.

### Thunder

Thunder is a weather sound, not an interaction sound, but it is synthesised the same way and
shares the master gain and mute control (`thunder.ts`). Three five-second mono peals, for strikes
at 1.2, 2.6 and 5.2 km, are rendered at 8 kHz (thunder holds nothing above 350 Hz) one per idle
period after sound starts, 480 kB in all, counted in the decoded budget. Each is brown noise
under a one-pole low-pass shaped into a crack (only for strikes nearer than 3 km) and three to
six rolling swells that die away over a few seconds, with the envelope evaluated every 32 samples
and interpolated; distance lowers the cut-off from 350 Hz to 90 Hz, as air absorbs the highs of a
far strike. Each strike takes the closest peal (rendering it at once if idle time has not come
yet) and varies it: playback rate 0.82–1.12 and a low-pass between 140 and 580 Hz that falls with
distance, so no two strikes rumble alike. The peal starts when the sound would arrive
(distance / 343 m/s after the flash), is panned where the strike was, and peaks at 0.55 for a
strike a kilometre away, falling as (1 km / distance)^0.8. Under reduced motion the scene shows no
lightning, so in a thunderstorm (or rain at 75% or more) the mixer rolls a distant, low rumble on
its own every 18–48 s, 4.5–7.5 km away, with no flash.

The waterfall recording is loaded only when the generated world contains a waterfall and
playback is enabled. Its loudness follows the fall's size and distance, with stereo placement
following its azimuth from the camera (`panFromCameraMatrix` in `pan.ts`), so a fall behind the
viewer stays on its own side instead of being mirrored as a screen projection would. Three-second loop crossfades and smoothed gains
avoid abrupt changes. The lake layer leaves a little room for this localized source, while
rain still masks part of it. The waterfall shares the existing master gain, context and mute
control; a failed download leaves the other layers playing. Processing and the circular
source-loop edit are recorded in the source manifest.

Browser tests enforce a 24 MiB decoded-buffer ceiling for all eight decoded clips at the production 32 kHz rate.
A runtime guard also enforces that ceiling, together with the reverb impulse and the thunder
peals, whose share is reserved before any clip is admitted. Clips are admitted in the fixed layer
order once all have decoded, not in decoding order, so the same layers play on every visit and
the base water, first in that order, can never be the one refused. Clips remain local; no audio request occurs until
the context is running and playback is enabled. The mixer is a separate lazy chunk, independent of Three.js.

A fresh page attempts playback after its first complete scene frame, unless the visitor turned
the sound off earlier (see below). The sound and
information controls appear with that frame. The sound button remains off while playback
is pending and switches on only when the mixer is running. If browser autoplay policy
refuses or leaves the context suspended after 300 ms, it stays off without fetching audio
or automatically retrying later. Explicit activation creates/
resumes the same context synchronously in the click handler, then loads the mixer.
[Browser autoplay rules](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
remain authoritative; sound cannot be guaranteed before a user gesture. Base water failure turns the command off with an
accessible retry message; secondary failures retain available layers. Network loads have
a 15-second timeout. Cancellation invalidates pending work and aborts fetches; late decoding
cannot start playback. The scene emits solar hour, daylight, wind speed and effective rain
initially and at most four times per second. Layer gains follow those values with a
2-second smoothing constant; the master fades in over 1.5 seconds and out over 300 ms.

Hiding pauses scheduling, fades down over 40 ms and suspends the context; returning resumes
with a fade when previously enabled. Refused resume turns the command off. Fades hold their
parameter with `cancelAndHoldAtTime`, or, in Firefox, which lacks it, with
`cancelScheduledValues` and the current value; layer gains and pans only ever follow targets.
When the system itself suspends or interrupts a running context while the page is visible (a
call, another app, iOS audio session changes), the command shows off with a status message and
the next tap or key press anywhere on the page resumes it; a click on the command then resumes
rather than stops. Motion preference changes retain the renderer and audio context. Pagehide
destroys audio; a restored page starts silent. A landscape failure releases audio and hides its
control.

Turning the sound off is remembered: the command stores `dotme:sound=off` in `localStorage`, and
later visits do not autoplay. Turning it on again removes the entry. Failures and system
interruptions are not remembered, and disabled storage simply forgets the choice.
