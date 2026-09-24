# Paris weather access

`src/weather/paris.ts` exports `fetchParisWeather({ signal? }): Promise<ParisWeather>` and the pure
`interpretWmoCode(code)` function. The page does not import this module, make weather requests,
display weather, or change the landscape based on weather.

A future integration can explicitly request a snapshot:

```ts
import { fetchParisWeather } from './weather/paris'

const controller = new AbortController()
const weather = await fetchParisWeather({ signal: controller.signal })
// Use weather.windSpeedMs, weather.condition, weather.indicators, etc.
// Call controller.abort() if the consumer is disposed before completion.
```

The request uses native `fetch`, without an SDK or key, for Paris (48.8566, 2.3522), with the
`Europe/Paris` timezone. Fields retain their numeric values; property suffixes identify units.
`timestampUnixSeconds` is the original UTC Unix timestamp requested from the API. Format it using
`new Date(weather.timestampUnixSeconds * 1000)` and `Intl.DateTimeFormat` with
`timeZone: weather.timezone`. `utcOffsetSeconds` is also retained; do not add it to the Unix timestamp
when constructing a Date.

Current conditions come from weather models at 15-minute resolution. `intervalSeconds` retains
the API's aggregation interval. `rainMm`, `showersMm`, and `snowfallCm` are accumulated amounts over
that preceding interval, **not instantaneous rates**. Wind speed and gusts are in m/s, wind direction
in degrees, cloud cover and humidity in percent, temperatures in °C, and visibility in meters.
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
every outcome. There are no retries, polling, cache or automatic calls.

The free endpoint is for **non-commercial use**. When integrating the data, provide visible credit
and a link to [Open-Meteo](https://open-meteo.com/), acknowledge its
[CC BY 4.0 licence](https://open-meteo.com/en/licence), and identify derived interpretations or other
modifications. Commercial use requires the appropriate API subscription; data attribution still
applies. Check the [current terms and limits](https://open-meteo.com/en/pricing) before integration.
