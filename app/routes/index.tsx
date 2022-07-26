import * as React from 'react'
import { json } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'
import { m } from 'framer-motion'

import { AboutMe } from '~/components/AboutMe'
import { Tracks } from '~/components/Tracks'
import { ControlTrack } from '~/components/ControlTrack'
import { PlayerAudio } from '~/components/PlayerAudio'

export const loader = async () => {
  const params = new URLSearchParams()

  params.append('grant_type', 'client_credentials')

  const { access_token: accessToken } = await fetch(
    `https://accounts.spotify.com/api/token?${params}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(
          `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
        )}`,
      },
    }
  ).then((res) => res.json())

  const { items } = await fetch(
    `https://api.spotify.com/v1/users/${process.env.SPOTIFY_USER_ID}/playlists/${process.env.SPOTIFY_PLAYLIST_ID}/tracks`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  ).then((res) => res.json())

  return json({
    tracks: items
      .map(({ track }) => ({
        id: track.id,
        name: track.name,
        url: track.external_urls.spotify,
        previewUrl: track.preview_url,
        album: {
          id: track.album.id,
          name: track.album.name,
          url: track.album.external_urls.spotify,
          image: track.album.images.find((image) => image.height === 300),
        },
        artists: track.artists.map((artist) => ({
          id: artist.id,
          name: artist.name,
          url: artist.external_urls.spotify,
        })),
      }))
      .filter((track) => track.previewUrl !== null),
  })
}

export default function Index() {
  const { tracks } = useLoaderData()

  const [currentTrack, setCurrentTrack] = React.useState(null)
  const [playerState, setPlayerState] = React.useState('stop')

  return (
    <>
      <m.div
        className="h-screen w-screen"
        animate={{
          backgroundColor: currentTrack?.trackColor ?? undefined,
        }}
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0)',
        }}
      >
        <div className="h-screen w-screen relative z-20">
          <div
            className={
              'fixed left-[100px] top-[100px] z-10 flex flex-col gap-3'
            }
          >
            <AboutMe variant={currentTrack?.colorVariant} />

            {currentTrack && (
              <ControlTrack
                variant={currentTrack?.colorVariant}
                onClick={() =>
                  setPlayerState((prev) => (prev === 'play' ? 'stop' : 'play'))
                }
                state={playerState}
              />
            )}
          </div>

          {tracks && (
            <Tracks
              currentTrack={currentTrack}
              tracks={tracks}
              onChange={(v) => {
                if (v.trackColor !== null) {
                  setCurrentTrack(v)
                }
              }}
            />
          )}
        </div>
      </m.div>

      {currentTrack && (
        <PlayerAudio
          track={currentTrack?.track}
          state={playerState}
          variant={currentTrack?.colorVariant}
        />
      )}
    </>
  )
}
