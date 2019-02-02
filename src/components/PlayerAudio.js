/* eslint-disable jsx-a11y/media-has-caption */

import React, { PureComponent } from 'react'
import { animated } from 'react-spring/hooks.cjs'
import styled from 'styled-components'
import Oscilloscope from 'oscilloscope'

import { mobile } from 'helpers/styles'

const WrapperCanvas = styled(animated.div)`
  display: flex;
  align-items: center;
  bottom: 0;
  justify-content: center;
  left: 0;
  pointer-events: none;
  position: fixed;
  right: 0;
  top: 0;
  z-index: 1;

  canvas {
    height: ${p => (p.visualisation === 'waveform' ? 25 : 100)}%;
    width: 100%;
  }

  ${mobile`
    bottom: auto;
    height: 90px;
    top: 110px;
    z-index: 9;

    canvas {
      height: 90px;
    }
  `}
`

function webAudioTouchUnlock(context) {
  return new Promise((resolve, reject) => {
    if (context.state === 'suspended' && 'ontouchstart' in window) {
      const unlock = () => {
        context.resume().then(
          () => {
            document.body.removeEventListener('touchstart', unlock)
            document.body.removeEventListener('touchend', unlock)

            resolve(true)
          },
          reason => {
            reject(reason)
          },
        )
      }

      document.body.addEventListener('touchstart', unlock, false)
      document.body.addEventListener('touchend', unlock, false)
    } else {
      resolve(false)
    }
  })
}

class PlayerAudio extends PureComponent {
  _canvas = React.createRef()

  _analyser = null
  _bufferLength = null
  _audioContext = null
  _audioSource = {}
  _controller = null
  _ctx = null
  _scope = null
  _requestProgress = null
  _requestDraw = null

  _startTime = 0
  _duration = 0

  componentDidMount() {
    this.initAudioContext()

    window.addEventListener('resize', this.setCanvasDimensions)

    this._ctx = this._canvas.current.getContext('2d')

    this.setCanvasDimensions()
  }

  async componentDidUpdate(prevProps) {
    const { currentTrack, canPlaying, onPlayingTrack, onLoadingTrack, visualisation } = this.props

    if (canPlaying === false) {
      window.cancelAnimationFrame(this._requestProgress)

      this.stopAudioSource()
      this.stopVisualiser()
    }

    if (visualisation !== prevProps.visualisation) {
      this.initVisualiser(this._audioSource[currentTrack.id])
    }

    if (canPlaying && currentTrack !== prevProps.currentTrack) {
      if (this._controller) {
        this._controller.abort()
      }

      this._controller = new window.AbortController()
      const { signal } = this._controller

      this.stopAudioSource()
      this.stopVisualiser()

      onLoadingTrack(currentTrack.id)
      onPlayingTrack(null)

      window.cancelAnimationFrame(this._requestProgress)

      try {
        const buffer = await fetch(currentTrack.preview, {
          signal,
        })
          .then(res => res.arrayBuffer())
          .then(
            res =>
              new Promise((resolve, reject) =>
                this._audioContext.decodeAudioData(
                  res,
                  buffer => resolve(buffer),
                  err => reject(err),
                ),
              ),
          )

        this._audioSource[currentTrack.id] = this._audioContext.createBufferSource()

        const audioSource = this._audioSource[currentTrack.id]

        this.initVisualiser(audioSource, {
          stop: visualisation !== prevProps.visualisation,
        })

        audioSource.buffer = buffer
        audioSource.connect(this._audioContext.destination)
        audioSource.connect(this._analyser)

        this._bufferLength = this._analyser.frequencyBinCount

        this._startTime = this._audioContext.currentTime
        this._duration = buffer.duration

        audioSource.start(0)

        this.handleProgress()

        onPlayingTrack(currentTrack.id)
        onLoadingTrack(null)
      } catch (e) {} // eslint-disable-line no-empty
    }
  }

  handleProgress = () => {
    const { canPlaying, onNextTrack, onProgressTrack } = this.props

    const progress = ((this._audioContext.currentTime - this._startTime) * 100) / this._duration

    if (progress >= 100) {
      onNextTrack()
    } else if (canPlaying) {
      onProgressTrack(progress || 0)
      this._requestProgress = window.requestAnimationFrame(this.handleProgress)
    }
  }

  initAudioContext = () => {
    if (!this._audioContext) {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)()

      this._analyser = this._audioContext.createAnalyser()
      this._analyser.connect(this._audioContext.destination)

      webAudioTouchUnlock(this._audioContext)
    }
  }

  initVisualiser = (audioSource, options = {}) => {
    const { visualisation } = this.props
    const { stop = true } = options

    this.setCtxStyle()

    if (stop) {
      this.stopVisualiser()
    }

    if (visualisation === 'waveform') {
      this._scope = new Oscilloscope(audioSource)
      this._scope.animate(this._ctx)
    } else {
      this.draw()
    }
  }

  stopVisualiser = () => {
    window.cancelAnimationFrame(this._requestDraw)
    this._scope && this._scope.stop()
    this._ctx.clearRect(0, 0, this._canvas.current.width, this._canvas.current.height)
  }

  getDataFromAudio = () => {
    const freqByteData = new Uint8Array(this._analyser.fftSize / 2)
    const timeByteData = new Uint8Array(this._analyser.fftSize / 2)
    this._analyser.getByteFrequencyData(freqByteData)
    this._analyser.getByteTimeDomainData(timeByteData)
    return { f: freqByteData, t: timeByteData }
  }

  draw = () => {
    if (!this._canvas.current) {
      return
    }

    const { canPlaying } = this.props

    this._ctx.clearRect(0, 0, this._canvas.current.width, this._canvas.current.height)

    const data = this.getDataFromAudio()
    const dataLength = data.f.length
    const barWidth = (250 / this._bufferLength) * 5

    let x = 0

    for (let i = 0; i < dataLength; i++) {
      const barHeight = -data.f[i] * 1.5

      this._ctx.fillRect(x, this._canvas.current.height, barWidth, barHeight)

      x += barWidth + 10
    }

    if (canPlaying) {
      this._requestDraw = window.requestAnimationFrame(this.draw)
    }
  }

  setCtxStyle = () => {
    const { visualisation, currentTrack } = this.props

    const color = `rgba(${currentTrack.color.isLight ? '0, 0, 0' : '255, 255, 255'}, 0.5)`

    if (visualisation === 'waveform') {
      this._ctx.strokeStyle = color
      this._ctx.lineWidth = 2
    } else {
      this._ctx.fillStyle = color
    }
  }

  stopAudioSource = () =>
    Object.keys(this._audioSource).forEach(id => {
      if (this._audioSource[id]) {
        this._audioSource[id].stop()
        delete this._audioSource[id]
      }
    })

  setCanvasDimensions = () => {
    if (this._canvas.current) {
      this._canvas.current.height = window.innerHeight
      this._canvas.current.width = window.innerWidth

      this.setCtxStyle()
    }
  }

  render() {
    const { bg, visualisation } = this.props
    return (
      <WrapperCanvas
        visualisation={visualisation}
        style={{
          backgroundColor: bg,
        }}
      >
        <canvas ref={this._canvas} />
      </WrapperCanvas>
    )
  }
}

export default PlayerAudio
