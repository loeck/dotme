/* eslint-disable jsx-a11y/media-has-caption */

import React, { Component } from 'react'
import styled from 'styled-components'
import Oscilloscope from 'oscilloscope'

import debounce from 'lodash/debounce'
import sample from 'lodash/sample'

import Box from 'meh-components/Box'

import { getProxyUrl } from 'helpers/url'

import ListTracks from 'components/ListTracks'
import Me from 'components/Me'
import Footer from 'components/Footer'

const WrapperAudio = styled.div`
  left: 0;
  opacity: 0;
  pointer-events: none;
  position: absolute;
  top: 0;
  z-index: -1;
`

const Wrapper = styled(Box).attrs({
  align: 'flex-end',
  style: p => ({
    background: p.bg || 'transparent',
  }),
})`
  color: white;
  height: 100%;
  min-width: 715px;
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

const TopLeft = styled(Box)`
  position: fixed;
  top: 105px;
  left: 105px;

  @media only screen and (max-width: 875px) {
    left: 20px;
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
    window.addEventListener('scroll', this.handleScroll)
    window.addEventListener('resize', this.setCanvasDimensions)

    this._player.addEventListener('canplay', async () => {
      this.setState({
        playing: true,
      })
      try {
        await this._player.play()
      } catch (e) {} // eslint-disable-line no-empty
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

    this.increaseCountPlaying()

    if (this._countPlaying >= COUNT_PLAYING_MAX) {
      this.fetchNewTracks()
    }

    this.setState({
      currentTrack: t,
      progress: 0,
      auto,
    })
  }

  setCTXColor = isLight => {
    if (this._ctx) {
      this._ctx.strokeStyle = `rgba(${isLight ? '0, 0, 0' : '255, 255, 255'}, 0.5)`
    }
  }

  increaseCountPlaying = debounce(() => (this._countPlaying += 1), 500)

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
    window.scrollBy({
      top: node.getBoundingClientRect().top - 105,
      behavior: 'smooth',
    })

  fetchNewTracks = () =>
    fetch('/api/spotify')
      .then(res => res.json())
      .then(data => {
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

  handleChangePlaying = state => (state ? this.setRandomTrack() : this.resetTrack({ stop: true }))

  handleScroll = debounce(() => {
    if (this._listTrackOvered) {
      return
    }

    if (this._currentTrackNode) {
      this.scrollToTrack(this._currentTrackNode)
    } else {
      window.scrollTo({
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

    const currentColor = currentTrack.color || tracks[0].color
    const bgIsLight = currentColor.isLight

    this.setCTXColor(bgIsLight)

    return (
      <>
        <WrapperAudio>
          <audio ref={n => (this._player = n)} preload="auto" />
        </WrapperAudio>
        <Wrapper bg={currentColor.value}>
          <WrapperCanvas>
            <canvas ref={n => (this._canvas = n)} />
          </WrapperCanvas>
          <TopLeft>
            <Me bgIsLight={bgIsLight} />
            <Footer
              bgIsLight={bgIsLight}
              onChangeTrack={this.setRandomTrack}
              onTogglePlaying={this.handleChangePlaying}
              playing={playing}
            />
          </TopLeft>
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
