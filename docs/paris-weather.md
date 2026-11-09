# Weather by GPS position

`src/weather/current.ts` exports `fetchWeather({ signal?, position? }): Promise<WeatherSnapshot>` and the pure
`interpretWmoCode(code)` function. The page preloads a snapshot for the URL’s `coordinates` position (Paris by default) while loading the engine,
before creating its first frame. `src/weather/scene.ts` maps the response into scene settings.

Consumers can also explicitly request a snapshot:

```ts
import { fetchWeather } from './weather/current'

const controller = new AbortController()
const weather = await fetchWeather({
  signal: controller.signal,
  position: { latitude: 1.3521, longitude: 103.8198 },
})
// Use weather.windSpeedMs, weather.condition, weather.indicators, etc.
// Call controller.abort() if the consumer is disposed before completion.
```

The request uses native `fetch`, without an SDK or key, for the selected coordinates, defaulting to Paris (48.8566, 2.3522).
The API uses `timezone=auto`; its IANA timezone is validated and retained. Fields retain their numeric values; property suffixes identify units.
`timestampUnixSeconds` is the original UTC Unix timestamp requested from the API. Format it using
`new Date(weather.timestampUnixSeconds * 1000)` and `Intl.DateTimeFormat` with
`timeZone: weather.timezone`. `utcOffsetSeconds` is also retained; do not add it to the Unix timestamp
when constructing a Date.

Current conditions come from weather models at 15-minute resolution. `intervalSeconds` retains
the API's aggregation interval. `rainMm`, `showersMm`, and `snowfallCm` are accumulated amounts over
that preceding interval, **not instantaneous rates**. Wind speed and gusts are in m/s, wind direction
in degrees, cloud cover and humidity in percent, temperatures in °C, and visibility in meters.
Today's `daily` sunrise and sunset arrive as Unix seconds in the same response
(`forecast_days=1`); they anchor the artistic day/night orbit to the real sun.
See the [Open-Meteo API documentation](https://open-meteo.com/en/docs).

`condition.kind` describes the WMO family; `weatherCode` preserves the original code, including
its intensity information. Additional condition flags retain freezing precipitation, hail, showers,
rime fog and snow grains. Unrecognized codes produce `unknown`.

The indicators are independent: `sunny` is explicitly an approximation (daylight and code 0 or 1),
`clouds` means cloud cover greater than zero, and rain/snow each follow positive amounts or their
corresponding codes. Drizzle counts as liquid precipitation. Thunderstorm codes alone do not imply
rain: amounts can establish it. Rain and snow may both be true. Fog, thunderstorm and hail follow
their WMO codes. Unknown codes can still have precipitation indicators from measured model amounts.

Missing, non-finite, out-of-range or incorrectly typed required values and unexpected units throw
`TypeError`. HTTP failures throw `WeatherHttpError` with a numeric `status`; network and JSON errors
propagate. The entire fetch and body read have a 10-second deadline (`AbortSignal.timeout`,
`TimeoutError`), combined with the caller's signal through `AbortSignal.any` (a small listener
fallback covers browsers without it). Caller cancellation preserves the signal's reason (normally
`AbortError`). The page wraps this helper in a shorter **3-second scene deadline**, configured by
`WEATHER_PRELOAD_TIMEOUT_MS` in `src/weather/scene.ts`. That deadline also covers downloading the
weather module. Timeout, HTTP, network and parsing failures select a seeded random preset. A
request that misses the scene deadline is not aborted: it may still finish in the background, up
to its own 10 seconds, and fill the cache for the next visit, but it never replaces the preset this
scene chose. Page disposal aborts the preload and its request; it does not trigger the random
fallback. Completed snapshots survive motion preference changes and bfcache restores for the same
page.

The last response is kept in `localStorage` (`dotme:weather`), together with its request URL, and
so with the requested coordinates. A reload with the same coordinates within the same 15-minute
observation slot reuses it instead of asking again; storage that is full or disabled only means a
fresh request. Nothing else about the visitor is stored.

`watchSceneWeather(options, onChange, signal)` in `src/weather/watch.ts` keeps a long visit
current: one request per 15-minute slot, a minute after the slot begins, only while the page is
visible (a hidden page catches up once on its return) and never for forced weather. `onChange`
receives each new slot's scene weather; failures are silent and retried at the next slot, or after
a minute when the scene opened on random weather. Aborting `signal` stops it. The landscape starts
it after the engine unless the weather is forced, and hands each refresh to the engine
(`setWeather`, eased over a minute, see [weather refresh](atmosphere.md#weather-refresh)) and to the
sound (`setWeather`).

Cloud cover selects clear (<20%), partly cloudy (<55%), cloudy (<85%) or overcast. Rain implies at
least a cloudy sky; fog, snow and thunderstorm codes use overcast. A dry overcast sky (no
precipitation, fog, snow or storm) is shown as cloudy instead: a flat grey deck is the dullest
frame the scene can open on, so it keeps its cloud but breaks up and lets the light reach the lake. Liquid precipitation is converted
from its reported interval to mm/hour, then mapped to the artistic rain intensity (0.12–1, saturated
at 8 mm/hour). WMO rain/drizzle codes supply an intensity when reported amounts are zero, and a
floor of 60% of their own intensity otherwise: fifteen-minute model amounts lag a heavy shower the
code already names, so a downpour code never plays as drizzle. Snow-only conditions do not create
rain; thunderstorms bring lightning (see [atmosphere](atmosphere.md)).

`SceneWeather` also carries the conditions beyond the sky preset, which the scene draws (fog banks,
snowfall and snow cover, see [atmosphere](atmosphere.md#fog) and [rain](rain-rendering.md#snow))
and the sound follows: `condition` (`dry`, `drizzle`, `rain`, `fog`, `snow` or `thunderstorm`), `fog` (0–1:
0.7 for WMO 45 and 0.8 for rime fog 48, or more from visibility, none at 5 km, half at 1 km, full
at 200 m), `snow` (0–1, from snowfall saturated at 2.5 cm/hour and the WMO 71–77 and 85–86 codes,
with the same code floor as rain), `temperature` (°C) and `humidity` (0–1). Snow codes select the
`snow` sky preset and fog codes the `fog` preset, as does a dry sky with under about 450 m of
visibility; snow keeps the overcast deck, fog a thin broken one above its banks.

Wind bearing and speed drive the rain and shared atmospheric/water wind model. Rain wind is capped
at 20 m/s, atmospheric mean speed at 8 m/s to fit the scene's wave model. Reported gusts set the
procedural gust strength; a gust beyond the symmetric range arrives as positive bursts, so a calm
mean with strong gusts still produces them. Rain keeps the reported wind and scales it each frame by the sampled gust factor. Sunrise, sunset and the snapshot time are converted to location-local
seconds past midnight and seed the solar clock and its orbit. Polar days without a sunrise
before sunset keep live weather with the default 06:00–18:00 orbit.

The public query parameters are `seed`, `coordinates=latitude,longitude`, `startTime=HH:MM`,
`timeScale=1..100` and `weather`.
`startTime` overrides the snapshot-seeded clock; without it the scene starts at the weather
location's local time rather than the visitor's.

`weather=clear|partly-cloudy|cloudy|overcast|fog|snow|rain|thunderstorm` bypasses the API and
selects an artistic preset. The four sky presets are dry at 18 °C; `fog` is fog 0.85 at 9 °C,
`snow` is snowfall 0.7 at -1 °C; `rain` uses an overcast sky with rain intensity 0.55, and
`thunderstorm` uses an overcast sky with intensity 1 and lightning. Wind stays seeded
for the visit. Forced weather uses the default solar orbit and the visitor's local time unless
`startTime` is set. Missing or unknown `weather` values keep the normal live-weather and fallback
path. Overrides survive URL cleanup and reloads, use `data-weather-source="override"`, and do not
show the live-data attribution.

The information button opens a dialog describing the scene and its libraries, including weather
attribution when live API data is used.

The free endpoint is for **non-commercial use**. When integrating the data, provide visible credit
and a link to [Open-Meteo](https://open-meteo.com/), acknowledge its
[CC BY 4.0 licence](https://open-meteo.com/en/licence), and identify derived interpretations or other
modifications. Commercial use requires the appropriate API subscription; data attribution still
applies. Check the [current terms and limits](https://open-meteo.com/en/pricing) before integration.
