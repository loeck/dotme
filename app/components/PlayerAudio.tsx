import * as React from 'react'
import { m, useAnimationControls } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'

export const PlayerAudio = ({ track, state, variant }) => {
  const canvasRef = React.useRef(null)

  const gainNodeRef = React.useRef<any>(null)
  const audioContextRef = React.useRef<any>(null)
  const audioSourceRef = React.useRef<any>({})
  const analyserRef = React.useRef<any>(null)

  const startTimeRef = React.useRef(null)
  const durationRef = React.useRef(null)

  const requestIdProgressRef = React.useRef(null)
  const requestIdDrawRef = React.useRef(null)

  const controlsProgress = useAnimationControls()

  const { data, isLoading } = useQuery(
    ['track', { id: track.id, previewUrl: track.previewUrl }],
    ({ queryKey }) => {
      const [, { previewUrl }] = queryKey

      return fetch(previewUrl).then((res) => res.arrayBuffer())
    },
    {
      enabled: state === 'play',
    }
  )

  const draw = () => {
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext('2d')

      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)

      const data = (() => {
        const freqByteData = new Uint8Array(analyserRef.current.fftSize / 2)

        analyserRef.current.getByteFrequencyData(freqByteData)

        return freqByteData
      })()
      const dataLength = data.length
      const barWidth = (250 / analyserRef.current.frequencyBinCount) * 5

      let x = 0

      ctx.fillStyle = `rgba(${
        variant === 'light' ? '0, 0, 0' : '255, 255, 255'
      }, 0.5)`

      for (let i = 0; i < dataLength; i++) {
        const v = data[i]
        // const barHeight = -v * (this._isMobile ? 1.3 : 1.4)
        const barHeight = -v * 1.4

        ctx.fillRect(x, canvasRef.current.height, barWidth, barHeight)
        ctx.fillRect(x, 0, barWidth, -barHeight)

        // x += barWidth + (this._isMobile ? 2 : 6)
        x += barWidth + 6
      }

      if (state === 'play') {
        requestIdDrawRef.current = requestAnimationFrame(draw)
      }
    }
  }

  const stopAudioSource = () => {
    Object.values(audioSourceRef.current).forEach((audioSource) => {
      audioSource.stop()
    })
  }

  const getProgress = () =>
    ((audioContextRef.current.currentTime - startTimeRef.current) * 100) /
    durationRef.current

  const handleProgress = () => {
    const progress = getProgress()

    controlsProgress.start({ opacity: 1, width: `${progress}%` })

    if (progress >= 100) {
      resetProgress()
    } else if (state === 'play') {
      requestIdProgressRef.current = requestAnimationFrame(handleProgress)
    }

    // if (progress >= 100) {
    //   onNextTrack()
    // } else if (canPlaying) {
    //   // onProgressTrack(progress || 0)
    //   requestIdProgressRef.current window.requestAnimationFrame(this.handleProgress)
    // }
  }

  const resetProgress = async (animate = false) => {
    if (requestIdProgressRef.current) {
      cancelAnimationFrame(requestIdProgressRef.current)
    }

    if (requestIdDrawRef.current) {
      cancelAnimationFrame(requestIdDrawRef.current)

      const ctx = canvasRef.current.getContext('2d')
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height)
    }

    controlsProgress.stop()

    if (animate) {
      await controlsProgress.start({ opacity: 0 })
    }

    controlsProgress.set({ width: `0%` })
  }

  React.useEffect(() => {
    const getBuffer = () => {
      if (audioContextRef.current === null) {
        audioContextRef.current = new AudioContext()

        analyserRef.current = audioContextRef.current.createAnalyser()
        analyserRef.current.connect(audioContextRef.current.destination)
      }

      return new Promise((resolve) => {
        try {
          audioContextRef.current.decodeAudioData(data, (buffer) =>
            resolve(buffer)
          )
        } catch (err) {}
      })
    }

    const playAudio = async () => {
      const buffer = await getBuffer()

      gainNodeRef.current = audioContextRef.current.createGain()

      audioSourceRef.current[track.id] =
        audioContextRef.current.createBufferSource()

      const audioSource = audioSourceRef.current[track.id]

      draw()

      audioSource.buffer = buffer
      audioSource.connect(gainNodeRef.current)

      gainNodeRef.current.connect(audioContextRef.current.destination)
      gainNodeRef.current.connect(analyserRef.current)

      startTimeRef.current = audioContextRef.current.currentTime
      durationRef.current = buffer.duration

      audioSource.start(0)

      handleProgress()

      gainNodeRef.current.connect(audioContextRef.current.destination)
    }

    if (data) {
      resetProgress()
      playAudio()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, track])

  React.useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.height = window.innerHeight
        canvasRef.current.width = window.innerWidth
      }
    }

    window.addEventListener('resize', handleResize)

    handleResize()

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  React.useEffect(() => {
    if (isLoading) {
      stopAudioSource()
      resetProgress()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading])

  React.useEffect(() => {
    if (state === 'stop') {
      stopAudioSource()
      resetProgress(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return (
    <div className="fixed inset-0 z-10 pointer-events-none">
      <m.div
        animate={controlsProgress}
        className="absolute inset-0 z-10"
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.1)',
          width: 0,
        }}
        transition={{
          ease: 'linear',
        }}
      />

      {state === 'play' && (
        <div
          className="absolute inset-0"
          style={{
            backdropFilter: 'blur(2px)',
          }}
        />
      )}

      <canvas className="h-full w-full" ref={canvasRef} />
    </div>
  )
}
