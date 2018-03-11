import express from 'express'
import axios from 'axios'
import querystring from 'querystring'
import NodeCache from 'node-cache'
import getColors from 'get-image-colors'

import sampleSize from 'lodash/sampleSize'

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_USER_ID,
  SPOTIFY_PLAYLIST_ID,
} = process.env

const cache = new NodeCache()

const SPOTIFY_SAMPLE_SIZE = 20

async function getSpotifyTracks(url, accessToken, tracks = []) {
  const { data } = await axios.get(url, {
    params: {
      fields: 'next,items(track(id,name,preview_url,href,album(artists,images)))',
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
          !cache.get(`color:${t.id}`) &&
          axios
            .get(t.image.small, {
              responseType: 'arraybuffer',
            })
            .then(({ data }) => ({
              id: t.id,
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

  colors.forEach(c => cache.set(`color:${c.id}`, c.color))

  sampleTracks = sampleTracks.map(t => ({
    ...t,
    color: cache.get(`color:${t.id}`),
  }))

  return sampleTracks
}

const router = express.Router()

router.get('/spotify', async (req, res) => {
  const cacheTracks = cache.get('tracks')

  if (cacheTracks) {
    const sampleTracks = await getSampleTracks(cacheTracks)

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
        artists: t.track.album.artists.map(a => a.name),
        name: t.track.name,
        preview: t.track.preview_url,
        image: {
          big: t.track.album.images[1].url,
          small: t.track.album.images[2].url,
        },
      }))

      cache.set('tracks', tracks, 3600)

      const sampleTracks = await getSampleTracks(tracks)

      res.send(sampleTracks)
    } catch (e) {
      console.log('e', e) // eslint-disable-line
    }
  }
})

export default router
