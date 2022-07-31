import * as React from 'react'
import { m, useAnimationControls } from 'framer-motion'
import { useQuery } from '@tanstack/react-query'

export const PlayerAudio = ({ track, state, variant, onTrackEnd }) => {
  const wrapperRef = React.useRef(null)
  const canvasRef = React.useRef(null)

  const gainNodeRef = React.useRef<any>(null)
  const audioContextRef = React.useRef<any>(null)
  const audioSourceRef = React.useRef<any>(null)
  const analyserRef = React.useRef<any>(null)

  const startTimeRef = React.useRef(null)
  const durationRef = React.useRef(null)

  const requestIdProgressRef = React.useRef(null)
  const requestIdDrawRef = React.useRef(null)

  const controlsProgress = useAnimationControls()

  const { data, isLoading } = useQuery(
    ['track', { id: track?.id, previewUrl: track?.previewUrl }],
    ({ queryKey }) => {
      const [, { previewUrl }] = queryKey

      return fetch(previewUrl).then((res) => res.arrayBuffer())
    },
    {
      enabled: Boolean(track && state === 'play'),
    }
  )

  const draw = () => {
    if (requestIdDrawRef.current) {
      cancelAnimationFrame(requestIdDrawRef.current)
    }

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

  const stopAudioSource = async () => {
    if (audioSourceRef.current) {
      await audioSourceRef.current.stop()
    }
  }

  const getProgress = () =>
    ((audioContextRef.current.currentTime - startTimeRef.current) * 100) /
    durationRef.current

  const handleProgress = () => {
    const progress = getProgress()

    controlsProgress.start({ opacity: 1, width: `${progress}%` })

    if (progress >= 100) {
      resetProgress()
      onTrackEnd()
    } else if (state === 'play') {
      requestIdProgressRef.current = requestAnimationFrame(handleProgress)
    }
  }

  const resetProgress = async (animate = false) => {
    if (requestIdProgressRef.current) {
      cancelAnimationFrame(requestIdProgressRef.current)
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

      return audioContextRef.current.decodeAudioData(data)
    }

    const playAudio = async () => {
      const buffer = await getBuffer()

      await stopAudioSource()

      gainNodeRef.current = audioContextRef.current.createGain()

      audioSourceRef.current = audioContextRef.current.createBufferSource()

      const audioSource = audioSourceRef.current

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
        const { height, width } =
          canvasRef.current.parentNode.getBoundingClientRect()

        canvasRef.current.height = height
        canvasRef.current.width = width
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
    <div className="fixed w-full h-full inset-0 z-10 pointer-events-none">
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

      {track && (
        <div
          className="absolute inset-0"
          style={{
            backdropFilter: 'blur(2px)',
          }}
        />
      )}

      <canvas className="invisible xl:visible h-full w-full" ref={canvasRef} />
    </div>
  )
}
