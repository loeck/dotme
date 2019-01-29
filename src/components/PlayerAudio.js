/* eslint-disable jsx-a11y/media-has-caption */

import React, { PureComponent } from 'react'
import styled from 'styled-components'
import Oscilloscope from 'oscilloscope'

import { getProxyUrl } from 'helpers/url'

import Box from 'meh-components/Box'

const WrapperAudio = styled.div`
  left: 0;
  opacity: 0;
  pointer-events: none;
  position: absolute;
  top: 0;
  z-index: -1;
`
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

class PlayerAudio extends PureComponent {
  _player = React.createRef()
  _canvas = React.createRef()
  _ctx = null
  _firstPlaying = true

  componentDidMount() {
    window.addEventListener('resize', this.setCanvasDimensions)

    this._player.current.addEventListener('loadstart', () => {
      const { canPlaying, onPlayingTrack, onLoadingTrack, currentTrack } = this.props
      if (canPlaying) {
        onLoadingTrack(currentTrack.id)
        onPlayingTrack(null)
      }
    })
    this._player.current.addEventListener('canplay', async () => {
      const { canPlaying, onPlayingTrack, onLoadingTrack, currentTrack } = this.props
      if (canPlaying) {
        try {
          await this._player.current.play()
        } catch (e) {} // eslint-disable-line no-empty
        onPlayingTrack(currentTrack.id)
        onLoadingTrack(null)
      }
    })
    this._player.current.addEventListener('timeupdate', e => {
      const { onProgressTrack } = this.props
      const { currentTime, duration } = e.target
      const progress = (currentTime * 100) / duration
      onProgressTrack(progress || 0)
    })
    this._player.current.addEventListener('ended', () => {
      const { canPlaying, onNextTrack } = this.props
      canPlaying && onNextTrack()
    })

    this._ctx = this._canvas.current.getContext('2d')
    this._ctx.lineWidth = 2

    this.setCanvasDimensions()
  }

  async componentDidUpdate(prevProps) {
    const { currentTrack, canPlaying } = this.props

    if (canPlaying === false) {
      this._player.current.pause()
      this._player.current.currentTime = 0
      this._player.current.src = ''
    } else if (prevProps.currentTrack !== currentTrack) {
      this._player.current.currentTime = 0

      if (this._firstPlaying) {
        const AudioContext = window.AudioContext || window.webkitAudioContext

        this._audioContext = new AudioContext()
        const source = this._audioContext.createMediaElementSource(this._player.current)
        source.connect(this._audioContext.destination)

        const scope = new Oscilloscope(source)
        scope.animate(this._ctx)

        await this._audioContext.resume()

        this._firstPlaying = false
      }

      this._ctx.strokeStyle = `rgba(${
        currentTrack.color.isLight ? '0, 0, 0' : '255, 255, 255'
      }, 0.5)`

      if (currentTrack.preview) {
        this._player.current.src = getProxyUrl(currentTrack.preview)
      } else {
        this._player.current.src = null
      }
    }
  }

  setCanvasDimensions = () => {
    this._canvas.current.height = window.innerHeight
    this._canvas.current.width = window.innerWidth
  }

  render() {
    return (
      <>
        <WrapperAudio>
          <audio ref={this._player} preload="auto" />
        </WrapperAudio>
        <WrapperCanvas>
          <canvas ref={this._canvas} />
        </WrapperCanvas>
      </>
    )
  }
}

export default PlayerAudio
