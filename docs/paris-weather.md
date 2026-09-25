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
propagate. The entire fetch and body read have a 10-second deadline (`TimeoutError`). Caller
cancellation preserves the signal's reason (normally `AbortError`). Timers/listeners are removed on
every outcome. The page wraps this helper in a shorter **3-second deadline**, configured by
`WEATHER_PRELOAD_TIMEOUT_MS` in `src/weather/scene.ts`. That deadline also covers downloading the
weather module. Timeout, HTTP, network and parsing failures select a seeded random preset and abort
the request. Late responses cannot replace the chosen preset. Page disposal aborts the preload;
it does not trigger the random fallback. Completed snapshots survive motion preference changes and
bfcache restores for the same page. There is no polling or persistent cache.

Cloud cover selects clear (<20%), partly cloudy (<55%), cloudy (<85%) or overcast. Rain implies at
least a cloudy sky; fog, snow and thunderstorm codes use overcast. Liquid precipitation is converted
from its reported interval to mm/hour, then mapped to the artistic rain intensity (0.12–1, saturated
at 8 mm/hour). WMO rain/drizzle codes supply an intensity when reported amounts are zero. Snow-only
conditions do not create rain. Snowflakes, lightning and weather-driven fog are not implemented.

Wind bearing and speed drive the rain and shared atmospheric/water wind model. Rain wind is capped
at 20 m/s, atmospheric mean speed at 8 m/s to fit the scene's wave model. Reported gusts set the
procedural gust strength. Sunrise, sunset and the snapshot time are converted to location-local
seconds past midnight and seed the solar clock and its orbit. Polar days without a sunrise
before sunset keep live weather with the default 06:00–18:00 orbit.

Only `seed`, `coordinates=latitude,longitude`, `startTime=HH:MM` and `timeScale=1..100` are public query parameters.
`startTime` overrides the snapshot-seeded clock; without it the scene starts at the weather
location's local time rather than the visitor's.
The information button opens a dialog describing the scene and its libraries, including weather
attribution when live API data is used.

The free endpoint is for **non-commercial use**. When integrating the data, provide visible credit
and a link to [Open-Meteo](https://open-meteo.com/), acknowledge its
[CC BY 4.0 licence](https://open-meteo.com/en/licence), and identify derived interpretations or other
modifications. Commercial use requires the appropriate API subscription; data attribution still
applies. Check the [current terms and limits](https://open-meteo.com/en/pricing) before integration.
