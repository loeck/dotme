import * as React from 'react'
import { json } from '@remix-run/node'
import { useLoaderData } from '@remix-run/react'
import { m, AnimatePresence, useAnimationControls } from 'framer-motion'
import { PlayIcon, StopIcon } from '@radix-ui/react-icons'
import { useQuery } from '@tanstack/react-query'

import { Author } from '~/components/Author'
import { Tracks } from '~/components/Tracks'

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
              'fixed left-[100px] top-[100px] z-10 flex flex-col gap-2'
            }
          >
            <Author variant={currentTrack?.colorVariant} />

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
        <PlayerAudio track={currentTrack?.track} state={playerState} />
      )}
    </>
  )
}

const PlayerAudio = ({ track, state }) => {
  const canvasRef = React.useRef(null)

  const gainNodeRef = React.useRef<any>(null)
  const audioContextRef = React.useRef<any>(null)
  const audioSourceRef = React.useRef<any>({})
  const startTimeRef = React.useRef(null)
  const durationRef = React.useRef(null)

  const requestIdProgressRef = React.useRef(null)

  const controlsProgress = useAnimationControls()

  const { data } = useQuery(
    ['track', { id: track.id, previewUrl: track.previewUrl }],
    ({ queryKey }) => {
      const [, { id, previewUrl }] = queryKey

      stopAudioSource()
      resetProgress()

      return fetch(previewUrl)
        .then((res) => res.arrayBuffer())
        .then((res) => {
          if (audioContextRef.current === null) {
            audioContextRef.current = new AudioContext()
          }

          return new Promise((resolve, reject) =>
            audioContextRef.current.decodeAudioData(
              res,
              (buffer) => resolve(buffer),
              (err) => reject(err)
            )
          )
        })
        .then((res) => {
          gainNodeRef.current = audioContextRef.current.createGain()

          audioSourceRef.current[id] =
            audioContextRef.current.createBufferSource()

          const audioSource = audioSourceRef.current[id]

          audioSource.buffer = res
          audioSource.connect(gainNodeRef.current)

          startTimeRef.current = audioContextRef.current.currentTime
          durationRef.current = res.duration

          audioSource.start(0)

          handleProgress()

          gainNodeRef.current.connect(audioContextRef.current.destination)
          // gainNodeRef.current.connect(this._analyser)
        })
    },
    {
      enabled: state === 'play',
    }
  )

  const stopAudioSource = () => {
    Object.values(audioSourceRef.current).forEach((audioSource) => {
      audioSource.stop()
    })
  }

  const handleProgress = () => {
    const progress =
      ((audioContextRef.current.currentTime - startTimeRef.current) * 100) /
      durationRef.current

    controlsProgress.start({ opacity: 1, width: `${progress}%` })

    if (progress >= 100) {
      resetProgress()
    } else if (state === 'play') {
      console.log('request', state)
      requestIdProgressRef.current = requestAnimationFrame(handleProgress)
    }

    // if (progress >= 100) {
    //   onNextTrack()
    // } else if (canPlaying) {
    //   // onProgressTrack(progress || 0)
    //   requestIdProgressRef.current window.requestAnimationFrame(this.handleProgress)
    // }
  }

  const resetProgress = () => {
    if (requestIdProgressRef.current) {
      cancelAnimationFrame(requestIdProgressRef.current)
    }
    controlsProgress.stop()
    controlsProgress.set({ width: `0%` })
  }

  React.useEffect(() => {
    if (state === 'stop') {
      stopAudioSource()
      resetProgress()
    }
  }, [state])

  console.log(state)

  return (
    <div className="fixed inset-0 z-10">
      <m.div
        animate={controlsProgress}
        className="absolute inset-0"
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.1)',
          width: 0,
        }}
        transition={{
          ease: 'linear',
        }}
      />

      <canvas ref={canvasRef} />
    </div>
  )
}

const ControlTrack = ({ variant, state, onClick }) => {
  return (
    <AnimatePresence>
      {variant && (
        <m.div
          className="px-2"
          initial={{
            y: '-100%',
          }}
          animate={{
            color: variant === 'light' ? '#fff' : '#000',
            y: 0,
          }}
        >
          <div className="cursor-pointer" onClick={onClick}>
            {state === 'stop' ? (
              <PlayIcon height={26} width={26} />
            ) : (
              <StopIcon height={26} width={26} />
            )}
          </div>
        </m.div>
      )}
    </AnimatePresence>
  )
}
