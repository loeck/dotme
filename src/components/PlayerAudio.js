/* eslint-disable jsx-a11y/media-has-caption */

import React, { Component } from 'react'
import styled from 'styled-components'
import Oscilloscope from 'oscilloscope'

import Box from 'meh-components/Box'

import { getProxyUrl } from 'helpers/url'

const WrapperCanvas = styled(Box).attrs({
  align: 'center',
  justify: 'center',
  sticky: true,
})`
  position: fixed;
  pointer-events: none;
  z-index: 1;

  canvas {
    height: 200px;
    width: 100%;
  }

  @media only screen and (max-width: 875px) {
    bottom: auto;
    height: 90px;
    top: 110px;
    z-index: 20;

    canvas {
      height: 90px;
    }
  }
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

class PlayerAudio extends Component {
  _canvas = React.createRef()

  _audioContext = null
  _audioSource = {}
  _controller = null
  _ctx = null
  _scope = null
  _requestProgress = null

  _startTime = 0
  _duration = 0

  componentDidMount() {
    this._audioContext = new (window.AudioContext || window.webkitAudioContext)()
    webAudioTouchUnlock(this._audioContext)

    window.addEventListener('resize', this.setCanvasDimensions)

    this._ctx = this._canvas.current.getContext('2d')
    this._ctx.lineWidth = 2

    this.setCanvasDimensions()
  }

  async componentDidUpdate(prevProps) {
    const { currentTrack, canPlaying, onPlayingTrack, onLoadingTrack } = this.props

    if (canPlaying === false) {
      this.stopAudioSource()
      this._scope.stop()
      window.cancelAnimationFrame(this._requestProgress)
    }

    if (canPlaying && currentTrack !== prevProps.currentTrack) {
      if (this._controller) {
        this._controller.abort()
      }

      this._controller = new window.AbortController()
      const { signal } = this._controller

      this.stopAudioSource()

      onLoadingTrack(currentTrack.id)
      onPlayingTrack(null)

      window.cancelAnimationFrame(this._requestProgress)
      this._scope && this._scope.stop()

      this._ctx.strokeStyle = `rgba(${
        currentTrack.color.isLight ? '0, 0, 0' : '255, 255, 255'
      }, 0.5)`

      try {
        const buffer = await fetch(getProxyUrl(currentTrack.preview), {
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

        this._scope = new Oscilloscope(audioSource)
        this._scope.animate(this._ctx)

        audioSource.buffer = buffer
        audioSource.connect(this._audioContext.destination)

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

  stopAudioSource = () =>
    Object.keys(this._audioSource).forEach(id => {
      if (this._audioSource[id]) {
        this._audioSource[id].stop()
        delete this._audioSource[id]
      }
    })

  setCanvasDimensions = () => {
    this._canvas.current.height = window.innerHeight
    this._canvas.current.width = window.innerWidth
  }

  render() {
    return (
      <WrapperCanvas>
        <canvas ref={this._canvas} />
      </WrapperCanvas>
    )
  }
}

export default PlayerAudio
