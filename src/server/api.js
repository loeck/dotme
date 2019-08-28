const axios = require('axios')
const fs = require('fs')
const getColors = require('get-image-colors')
const moment = require('moment')
const querystring = require('querystring')
const tmp = require('tmp')

const sample = require('lodash/sample')
const shuffle = require('lodash/shuffle')

process.noDeprecation = true

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_PLAYLIST_ID,
  SPOTIFY_SAMPLE_SIZE,
  SPOTIFY_USER_ID,
} = process.env

const { name: tmpDir } = tmp.dirSync()

function getCache(name, defaultValues) {
  let cache = {
    lastModified: 0,
    values: defaultValues,
  }

  try {
    cache = JSON.parse(fs.readFileSync(`${tmpDir}/${name}.json`))
  } catch (e) {} // eslint-disable-line no-empty

  return cache
}

function setCache(name, values) {
  const cache = {
    lastModified: moment().format('DD-MM-YYYY'),
    values,
  }

  try {
    fs.writeFileSync(`${tmpDir}/${name}.json`, JSON.stringify(cache, null, 2))
  } catch (e) {} // eslint-disable-line no-empty

  return cache
}

const cache = {
  colors: getCache('colors', {}),
  tracks: getCache('tracks', []),
}

async function getSpotifyTracks(url, accessToken, tracks = []) {
  const { data } = await axios.get(url, {
    params: {
      fields: 'next,items(track(id,name,preview_url,href,album(id,name,artists,images)))',
    },
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (data.next) {
    return getSpotifyTracks(data.next, accessToken, [...data.items, ...tracks])
  }

  return tracks.filter(t => t.track.preview_url !== null)
}

async function getSampleTracks(tracks) {
  const ids = []
  let sampleTracks = []

  if (SPOTIFY_SAMPLE_SIZE === 'all') {
    sampleTracks = tracks
  } else {
    while (ids.length < SPOTIFY_SAMPLE_SIZE) {
      const t = sample(tracks)
      if (!ids.includes(t.id)) {
        sampleTracks.push(t)
        ids.push(t.id)
      }
    }
  }

  sampleTracks = shuffle(sampleTracks)

  const colors = await Promise.all(
    sampleTracks
      .map(
        t =>
          !cache.colors.values[t.album.id] &&
          axios
            .get(t.image.small, {
              responseType: 'arraybuffer',
            })
            .then(({ data }) => ({
              id: t.album.id,
              value: data,
            }))
            .catch(() => null),
      )
      .filter(Boolean),
  ).then(results =>
    Promise.all(
      results
        .map(
          r =>
            r &&
            getColors(r.value, 'image/jpeg')
              .then(colors => {
                const rgb = colors[0].rgb()
                const yiq = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000

                return {
                  id: r.id,
                  color: {
                    isLight: yiq > 128,
                    value: colors[0].hex(),
                  },
                }
              })
              .catch(() => null),
        )
        .filter(Boolean),
    ),
  )

  if (colors.length > 0) {
    cache.colors = setCache('colors', {
      ...cache.colors.values,
      ...colors.reduce((result, c) => {
        result[c.id] = c.color
        return result
      }, {}),
    })
  }

  sampleTracks = sampleTracks.map(t => ({
    ...t,
    color: cache.colors.values[t.album.id],
  }))

  return sampleTracks
}

module.exports = async (req, res) => {
  const cacheTracks = cache.tracks

  if (cacheTracks.lastModified === moment().format('DD-MM-YYYY')) {
    const sampleTracks = await getSampleTracks(cacheTracks.values)

    res.send(sampleTracks)
  } else {
    const formData = querystring.stringify({
      grant_type: 'client_credentials',
    })

    try {
      const {
        data: { access_token: accessToken },
      } = await axios.post('https://accounts.spotify.com/api/token', formData, {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`,
          ).toString('base64')}`,
        },
      })

      const tracks = await getSpotifyTracks(
        `https://api.spotify.com/v1/users/${SPOTIFY_USER_ID}/playlists/${SPOTIFY_PLAYLIST_ID}/tracks`,
        accessToken,
      ).then(tracks =>
        tracks.map(({ track }) => ({
          id: track.id,
          album: {
            id: track.album.id,
            name: track.album.name,
          },
          artists: track.album.artists.map(a => a.name),
          name: track.name,
          preview: track.preview_url,
          image: {
            big: track.album.images[1].url,
            small: track.album.images[2].url,
          },
        })),
      )

      cache.tracks = setCache('tracks', tracks)

      const sampleTracks = await getSampleTracks(tracks)

      res.send(sampleTracks)
    } catch (e) {
      res.send({})
    }
  }
}
