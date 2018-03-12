/* eslint-disable jsx-a11y/media-has-caption */

import React, { Component } from 'react'
import styled from 'styled-components'
import axios from 'axios'
import Oscilloscope from 'oscilloscope'
import Color from 'color'

import debounce from 'lodash/debounce'
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
  min-width: 715px;
  overflow-x: hidden;
  overflow: scroll;
  position: relative;
  transition: all ease-in-out 0.1s;
  z-index: 2;
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

const COUNT_PLAYING_MAX = 5

class Home extends Component {
  state = {
    auto: false,
    currentTrack: {},
    duration: 30,
    playing: false,
    progress: 0,
    tracks: this.props.tracks.slice(0, 20),
  }

  componentDidMount() {
    window.addEventListener('resize', this.setCanvasDimensions)

    this._player.addEventListener('progress', async e => {
      if (e.target.networkState === 1) {
        this.setState({
          playing: true,
        })
        try {
          await this._player.play()
        } catch (e) {} // eslint-disable-line no-empty
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
    const { currentTrack } = this.state

    if (prevState.currentTrack !== currentTrack) {
      this.setCTXColor()

      this._player.currentTime = 0

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
    const { tracks } = this.state

    let sampleTrack = currentTrack

    while (sampleTrack === currentTrack) {
      sampleTrack = sample(tracks)
    }

    this.setTrack(sampleTrack, { auto: true })
  }

  setTrack = (t, options = {}) => {
    const { auto = false } = options

    this._countPlaying += 1

    if (this._countPlaying >= COUNT_PLAYING_MAX) {
      this.fetchNewTracks()
    }

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

  scrollToTrack = node =>
    this._wrapper.scrollBy({
      top: node.getBoundingClientRect().top - 105,
      behavior: 'smooth',
    })

  fetchNewTracks = () =>
    axios.get('/api/spotify').then(({ data }) => {
      const { tracks, currentTrack } = this.state

      this._countPlaying = 0

      const index = tracks.indexOf(currentTrack)

      data = data.filter(d => d.id !== currentTrack.id)
      data = data.slice(0, 20)

      data[index] = currentTrack

      this.setState({
        tracks: data,
      })
    })

  handleChangeTrack = node => {
    this._listTrackOvered = false
    this._currentTrackNode = node
    this.scrollToTrack(node)
  }

  handleChangePlaying = state => {
    if (state) {
      this.setRandomTrack()
    } else {
      this.resetTrack({ stop: true })
    }
  }

  handleScroll = debounce(() => {
    if (this._listTrackOvered) {
      return
    }

    if (this._currentTrackNode) {
      this.scrollToTrack(this._currentTrackNode)
    } else {
      this._wrapper.scrollTo({
        top: 0,
        behavior: 'smooth',
      })
    }
  }, 500)

  _countPlaying = 0
  _canvas = null
  _ctx = null
  _currentTrackNode = null
  _listTrackOvered = false
  _player = null

  render() {
    const { tracks, currentTrack, auto, playing, progress, duration } = this.state

    const { color: currentColor } = currentTrack
    const bgIsLight = new Color(currentColor).isLight()

    return (
      <>
        <audio ref={n => (this._player = n)} style={{ display: 'none' }} />
        <Wrapper
          bg={currentTrack.color}
          innerRef={n => (this._wrapper = n)}
          onScroll={this.handleScroll}
        >
          <WrapperCanvas>
            <canvas ref={n => (this._canvas = n)} />
          </WrapperCanvas>
          <Me bgIsLight={bgIsLight} />
          <Footer
            bgIsLight={bgIsLight}
            onChangeTrack={this.setRandomTrack}
            onTogglePlaying={this.handleChangePlaying}
            playing={playing}
          />
          <ListTracks
            onMouseEnter={() => (this._listTrackOvered = true)}
            bgIsLight={bgIsLight}
            currentTrack={currentTrack}
            duration={duration}
            onChangeTrack={this.handleChangeTrack}
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
