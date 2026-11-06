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
The water therefore leaves room for the other layers instead of dominating rain.

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
budget and is requested only when due; hiding the page stops the piece. There is no thunder
or meteor sound.

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
otherwise: neither scale holds a semitone against either piece. Notes are synthesised with
oscillators, so they add nothing to the download or the decoded budget; they share the master
gain and mute control, are attenuated and panned like the splashes, and stay silent while
playback is paused or off. A new interaction sound should follow the same rules and be added to
this section.

The waterfall recording is loaded only when the generated world contains a waterfall and
playback is enabled. Its loudness follows the fall's size and distance, with stereo placement
following its position in the camera view. Three-second loop crossfades and smoothed gains
avoid abrupt changes. The lake layer leaves a little room for this localized source, while
rain still masks part of it. The waterfall shares the existing master gain, context and mute
control; a failed download leaves the other layers playing. Processing and the circular
source-loop edit are recorded in the source manifest.

Browser tests enforce a 24 MiB decoded-buffer ceiling for all eight decoded clips at the production 32 kHz rate.
A runtime guard also enforces that ceiling. Clips remain local; no audio request occurs until
the context is running and playback is enabled. The mixer is a separate lazy chunk, independent of Three.js.

A fresh page attempts playback after its first complete scene frame. The sound and
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
with a fade when previously enabled. Refused resume turns the command off. Motion preference changes retain the renderer and audio context. Pagehide destroys audio; a restored page
starts silent. A landscape failure releases audio and hides its control. No preference is persisted.
