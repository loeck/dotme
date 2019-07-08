import axios from 'axios'
import fs from 'fs'
import getColors from 'get-image-colors'
import moment from 'moment'
import querystring from 'querystring'
import tmp from 'tmp'

import sample from 'lodash/sample'
import shuffle from 'lodash/shuffle'

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

export default async (req, res) => {
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

      let tracks = await getSpotifyTracks(
        `https://api.spotify.com/v1/users/${SPOTIFY_USER_ID}/playlists/${SPOTIFY_PLAYLIST_ID}/tracks`,
        accessToken,
      )

      tracks = tracks.map(t => ({
        id: t.track.id,
        album: {
          id: t.track.album.id,
          name: t.track.album.name,
        },
        artists: t.track.album.artists.map(a => a.name),
        name: t.track.name,
        preview: t.track.preview_url,
        image: {
          big: t.track.album.images[1].url,
          small: t.track.album.images[2].url,
        },
      }))

      cache.tracks = setCache('tracks', tracks)

      const sampleTracks = await getSampleTracks(tracks)

      res.send(sampleTracks)
    } catch (e) {
      res.send({})
    }
  }
}
