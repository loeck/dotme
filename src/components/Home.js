/* eslint-disable jsx-a11y/media-has-caption */

import React, { Component } from 'react'
import styled from 'styled-components'
import Oscilloscope from 'oscilloscope'
import Color from 'color'

import sample from 'lodash/sample'

import Box from 'meh-components/Box'

import { getProxyUrl } from 'helpers/url'

import ListTracks from 'components/ListTracks'
import Me from 'components/Me'
import Footer from 'components/Footer'

const Wrapper = styled(Box).attrs({
  align: 'flex-end',
  style: p => ({
    background: p.bg || 'transparent',
  }),
})`
  color: white;
  height: 100vh;
  position: relative;
  overflow: scroll;
  overflow-x: hidden;
  z-index: 2;
  transition: all ease-in-out 0.1s;
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
`

class Home extends Component {
  state = {
    auto: false,
    currentTrack: {},
    duration: 30,
    progress: 0,
    playing: false,
    volume: 1,
  }

  componentDidMount() {
    window.addEventListener('resize', this.setCanvasDimensions)

    this._player.addEventListener('progress', e => {
      if (e.target.networkState === 1) {
        this.setState({
          playing: true,
        })
        this._player.play()
      }
    })
    this._player.addEventListener('timeupdate', e => {
      const { currentTime, duration } = e.target

      this.setState({
        duration,
        progress: currentTime,
      })
    })
    this._player.addEventListener('pause', () => {
      const { auto } = this.state

      if (auto) {
        this.setRandomTrack()
      } else {
        this.resetTrack()
      }
    })

    this._ctx = this._canvas.getContext('2d')
    this._ctx.lineWidth = 2

    this.setCanvasDimensions()

    const audioContext = new window.AudioContext()
    const source = audioContext.createMediaElementSource(this._player)
    source.connect(audioContext.destination)

    const scope = new Oscilloscope(source)
    scope.animate(this._ctx)
  }

  componentDidUpdate(prevProps, prevState) {
    const { currentTrack, volume } = this.state

    if (prevState.currentTrack !== currentTrack) {
      this.setCTXColor()

      this._player.currentTime = 0
      this._player.volume = volume

      if (currentTrack.preview) {
        this._player.src = getProxyUrl(currentTrack.preview)
      } else {
        this._player.src = ''
      }
    }
  }

  setCanvasDimensions = () => {
    this._canvas.height = window.innerHeight
    this._canvas.width = window.innerWidth

    this.setCTXColor()
  }

  setRandomTrack = () => {
    const { currentTrack } = this.state
    const { tracks } = this.props

    let sampleTrack = currentTrack

    while (sampleTrack === currentTrack) {
      sampleTrack = sample(tracks)
    }

    this.setTrack(sampleTrack, { auto: true })
  }

  setTrack = (t, options = {}) => {
    const { auto = false } = options

    this.setState({
      currentTrack: t,
      progress: 0,
      auto,
    })
  }

  setCTXColor = () => {
    const { currentTrack } = this.state

    if (currentTrack.color) {
      this._ctx.strokeStyle = `rgba(${
        new Color(currentTrack.color).isLight() ? '0, 0, 0' : '255, 255, 255'
      }, 0.5)`
    } else {
      this._ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
    }
  }

  resetTrack = (options = {}) => {
    const { stop = false } = options

    this.setState({
      currentTrack: {},
      playing: false,
      auto: false,
    })

    if (!stop) {
      this.setRandomTrack()
    }
  }

  handleChangePlaying = state => {
    if (state) {
      this.setRandomTrack()
    } else {
      this.resetTrack({ stop: true })
    }
  }

  handleChangeVolume = volume => {
    this._player.volume = volume

    this.setState({
      volume,
    })
  }

  _player = null
  _canvas = null
  _ctx = null

  render() {
    const { tracks } = this.props
    const { currentTrack, auto, playing, volume, progress, duration } = this.state

    const { color: currentColor } = currentTrack
    const bgIsLight = new Color(currentColor).isLight()

    return (
      <>
        <audio ref={n => (this._player = n)} style={{ display: 'none' }} />
        <Wrapper bg={currentTrack.color}>
          <WrapperCanvas>
            <canvas ref={n => (this._canvas = n)} />
          </WrapperCanvas>
          <Me bgIsLight={bgIsLight} />
          <Footer
            onTogglePlaying={this.handleChangePlaying}
            onChangeVolume={this.handleChangeVolume}
            volume={volume}
            playing={playing}
            bgIsLight={bgIsLight}
          />
          <ListTracks
            bgIsLight={bgIsLight}
            currentTrack={currentTrack}
            duration={duration}
            onSetTrack={this.setTrack}
            playing={playing}
            progress={progress}
            scrollTo={auto}
            tracks={tracks}
          />
        </Wrapper>
      </>
    )
  }
}

export default Home
