/* eslint-disable jsx-a11y/media-has-caption */

import React, { Component } from 'react'
import styled from 'styled-components'
import Oscilloscope from 'oscilloscope'
import Color from 'color'

import sample from 'lodash/sample'

import Box from 'meh-components/Box'

import { getProxyUrl } from 'helpers/url'

import ListTracks from 'components/ListTracks'

const Wrapper = styled(Box).attrs({})`
  background: ${p => p.bg || 'transparent'};
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

const Me = styled(Box)`
  color: ${p => (new Color(p.bg).isLight() ? 'white' : 'black')};
  background: ${p => (new Color(p.bg).isLight() ? 'black' : 'white')};
  position: fixed;
  top: 100px;
  left: 50px;
  padding: 20px;
  transition: all ease-in-out 0.1s;
  user-select: none;
  z-index: 2;

  a {
    background: ${p => (new Color(p.bg).isLight() ? 'white' : 'black')};
    color: ${p => (new Color(p.bg).isLight() ? 'black' : 'white')};
    display: inline-block;
    padding: 2px;
    margin: -2px 0;
    text-decoration: none;
    transition: all ease-in-out 0.1s;
  }
`

class Home extends Component {
  state = {
    duration: 30,
    currentTrack: {},
  }

  componentDidMount() {
    window.document.addEventListener('mouseout', e => {
      if (!e.relatedTarget && !e.toElement) {
        const { auto } = this.state

        if (!auto) {
          this.setTrack({})
        }
      }
    })

    this._player.addEventListener('canplay', () => this._player.play())
    this._player.addEventListener('pause', () => {
      const { auto } = this.state

      if (auto) {
        this.setRandomTrack()
      } else {
        this.setTrack({})
      }
    })
    this._player.addEventListener('playing', e => {
      const { currentTrack } = this.state
      const { duration } = e.target

      this.setState({
        duration,
      })

      this._ctx.strokeStyle = `rgba(${
        new Color(currentTrack.color).isLight() ? '0, 0, 0' : '255, 255, 255'
      }, 0.5)`
    })

    const audioContext = new window.AudioContext()
    const source = audioContext.createMediaElementSource(this._player)
    source.connect(audioContext.destination)

    this._canvas.height = window.innerHeight
    this._canvas.width = window.innerWidth

    this._ctx = this._canvas.getContext('2d')
    this._ctx.lineWidth = 2
    this._ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'

    const scope = new Oscilloscope(source)
    scope.animate(this._ctx)

    this.setRandomTrack()
  }

  componentDidUpdate(prevProps, prevState) {
    const { currentTrack } = this.state

    if (prevState.currentTrack !== currentTrack) {
      this._player.currentTime = 0

      if (currentTrack.preview) {
        this._player.src = getProxyUrl(currentTrack.preview)
      } else {
        this._player.src = ''
        this._ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
      }
    }
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
      auto,
    })
  }

  _player = null
  _canvas = null
  _ctx = null

  render() {
    const { tracks } = this.props
    const { currentTrack, duration, auto } = this.state

    return (
      <>
        <audio ref={n => (this._player = n)} style={{ display: 'none' }} />
        <Wrapper bg={currentTrack.color}>
          <WrapperCanvas>
            <canvas ref={n => (this._canvas = n)} />
          </WrapperCanvas>
          <Me bg={currentTrack.color} flow={10}>
            <div>Hi, I&apos;m Loëck !</div>
            <div>
              I work in Paris at{' '}
              <a href="https://ledger.fr" target="_blank" rel="noopener noreferrer">
                Ledger
              </a>{' '}
              as a Senior Front-end Developer.
            </div>
            <div>
              <a href="https://github.com/loeck" target="_blank" rel="noopener noreferrer">
                Github
              </a>{' '}
              /{' '}
              <a
                href="https://linkedin.com/in/lo%C3%ABck-v%C3%A9zien-19a0a550/"
                target="_blank"
                rel="noopener noreferrer"
              >
                LinkedIn
              </a>
            </div>
          </Me>
          <ListTracks
            scrollTo={auto}
            duration={duration}
            currentTrack={currentTrack}
            tracks={tracks}
            onSetTrack={this.setTrack}
          />
        </Wrapper>
      </>
    )
  }
}

export default Home
