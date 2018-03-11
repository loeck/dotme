import React, { PureComponent } from 'react'
import styled, { keyframes } from 'styled-components'
import Color from 'color'

import Box from 'meh-components/Box'

import IconDisc from 'icons/Disc'

const rotate360 = keyframes`
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
`

const Wrapper = styled(Box)`
  margin-left: 50%;
  padding: 100px 50px;
  position: relative;
  width: 500px;
  z-index: 2;
`
const Track = styled(Box).attrs({
  style: p => ({
    background: p.bg || 'black',
  }),
})`
  color: ${p => (p.bgIsLight ? 'black' : 'white')};
  padding: 20px;
  overflow: hidden;
  position: relative;
  transition: all ease-in-out 0.1s;
  user-select: none;

  &:after {
    background: rgba(${p => (p.bgIsLight ? '0, 0, 0' : '255, 255, 255')}, 0.5);
    bottom: 0;
    content: ' ';
    height: 2px;
    left: 0;
    position: absolute;
    right: ${p => (p.playing ? 0 : '100%')};
    transition: right linear ${p => (p.playing ? p.duration : 0)}s;
    z-index: 3;
  }
`
const TrackContent = styled(Box).attrs({
  align: 'center',
  horizontal: true,
  flow: 20,
})`
  position: relative;
  z-index: 1;
`
const TrackName = styled(Box)``
const TrackArtist = styled(Box)`
  font-size: 11px;
`
const TrackImage = styled(Box)`
  img {
    display: block;
    height: 65px;
  }
`

const TrackIcon = styled(Box).attrs({
  align: 'center',
  justify: 'center',
  style: p => ({
    background: p.bg || 'black',
  }),
})`
  bottom: 0;
  padding: 20px;
  position: absolute;
  right: 0;
  top: 0;
  z-index: 2;
  transform: translate3d(${p => (p.active ? 0 : 60)}px, 0, 0);
  transition: all ease-in-out 0.1s;

  svg {
    animation: ${p => (p.active ? `${rotate360} 2s linear infinite;` : null)};
  }
`

class ListTracks extends PureComponent {
  componentWillReceiveProps(nextProps) {
    const { currentTrack, scrollTo } = nextProps

    if (scrollTo && currentTrack !== this.props.currentTrack) {
      const node = this._track[currentTrack.id]

      if (node) {
        node.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }

  _track = {}

  render() {
    const { tracks, currentTrack, onSetTrack, duration, playing } = this.props

    return (
      <Wrapper>
        {tracks.map(t => {
          const active = t.id === currentTrack.id

          return (
            <Track
              bg={t.color}
              bgIsLight={new Color(t.color).isLight()}
              duration={duration}
              innerRef={n => (this._track[t.id] = n)}
              key={t.id}
              onMouseEnter={() => onSetTrack(t)}
              playing={active && playing}
            >
              <TrackContent>
                <TrackImage>
                  <img src={t.image.big} alt="" />
                </TrackImage>
                <Box flow={5}>
                  <TrackName>{t.name}</TrackName>
                  <TrackArtist>{t.artists.join(', ')}</TrackArtist>
                </Box>
              </TrackContent>
              <TrackIcon bg={t.color} active={active}>
                <IconDisc height={20} width={20} />
              </TrackIcon>
            </Track>
          )
        })}
      </Wrapper>
    )
  }
}

export default ListTracks
