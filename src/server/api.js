import axios from 'axios'
import express from 'express'
import fs from 'fs'
import getColors from 'get-image-colors'
import moment from 'moment'
import path from 'path'
import querystring from 'querystring'

import sampleSize from 'lodash/sampleSize'

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_USER_ID,
  SPOTIFY_PLAYLIST_ID,
} = process.env

function getCache(name, defaultValues) {
  let cache = {
    lastModified: 0,
    values: defaultValues,
  }

  try {
    cache = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../cache/${name}.json`)))
  } catch (e) {} // eslint-disable-line no-empty

  return cache
}

function setCache(name, values) {
  const cache = {
    lastModified: moment().format('DD-MM-YYYY'),
    values,
  }

  fs.writeFileSync(
    path.resolve(__dirname, `../../cache/${name}.json`),
    JSON.stringify(cache, null, 2),
  )

  return cache
}

const cache = {
  tracks: getCache('tracks', []),
  colors: getCache('colors', {}),
}

const SPOTIFY_SAMPLE_SIZE = 21

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
  let sampleTracks = sampleSize(tracks, SPOTIFY_SAMPLE_SIZE)

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
            })),
      )
      .filter(Boolean),
  ).then(results =>
    Promise.all(
      results.map(r =>
        getColors(r.value, 'image/jpeg').then(colors => ({
          id: r.id,
          color: colors[0].hex(),
        })),
      ),
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

const router = express.Router()

router.get('/spotify', async (req, res) => {
  const cacheTracks = cache.tracks

  if (cacheTracks.lastModified === moment().format('DD-MM-YYYY')) {
    const sampleTracks = await getSampleTracks(cacheTracks.values)

    res.send(sampleTracks)
  } else {
    const formData = querystring.stringify({
      grant_type: 'client_credentials',
    })

    try {
      const { data: { access_token: accessToken } } = await axios.post(
        'https://accounts.spotify.com/api/token',
        formData,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`,
            ).toString('base64')}`,
          },
        },
      )

      let tracks = await getSpotifyTracks(
        `	https://api.spotify.com/v1/users/${SPOTIFY_USER_ID}/playlists/${SPOTIFY_PLAYLIST_ID}/tracks`,
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

      setCache('tracks', tracks)

      const sampleTracks = await getSampleTracks(tracks)

      res.send(sampleTracks)
    } catch (e) {
      console.log('e', e) // eslint-disable-line
    }
  }
})

export default router
