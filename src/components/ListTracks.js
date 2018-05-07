import React, { PureComponent } from 'react'
import styled, { keyframes } from 'styled-components'

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
  margin: 105px;
  padding-bottom: calc(100vh - 315px);
  position: relative;
  transition: all ease-in-out 0.1s;
  width: 500px;
  z-index: 2;

  @media only screen and (max-width: 1175px) {
    width: 400px;
  }

  @media only screen and (max-width: 975px) {
    width: 300px;
  }

  @media only screen and (max-width: 875px) {
    margin-right: 20px;
  }
`
const Track = styled(Box).attrs({
  style: p => ({
    background: p.bg || 'black',
  }),
})`
  color: ${p => (p.bgIsLight ? 'black' : 'white')};
  cursor: pointer;
  padding: 20px;
  overflow: hidden;
  position: relative;
  transition: all ease-in-out 0.1s;
  user-select: none;

  a {
    text-decoration: none;
  }
`
const TrackProgress = styled(Box).attrs({
  style: p => ({
    width: `${p.progress / p.duration * 100}%`,
  }),
})`
  background: rgba(${p => (p.bgIsLight ? '0, 0, 0' : '255, 255, 255')}, 0.5);
  bottom: 0;
  content: ' ';
  height: 2px;
  left: 0;
  position: absolute;
  z-index: 3;
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
  transform: translate3d(${p => (p.active ? 0 : 40)}px, 0, 0);
  transition: all ease-in-out 0.1s;

  svg {
    animation: ${p => (p.active ? `${rotate360} 2s linear infinite;` : null)};
  }
`

class ListTracks extends PureComponent {
  componentWillReceiveProps(nextProps) {
    const { currentTrack, scrollTo } = nextProps

    if (scrollTo && currentTrack !== this.props.currentTrack) {
      this.changeTrack(currentTrack)
    }
  }

  changeTrack = currentTrack => {
    const { onChangeTrack } = this.props

    const node = this._track[currentTrack.id]

    if (node) {
      onChangeTrack(node)
    }
  }

  _track = {}

  render() {
    const {
      tracks,
      currentTrack,
      progress,
      onSetTrack,
      duration,
      playing,
      canPlay,
      ...otherProps
    } = this.props

    return (
      <Wrapper onMouseLeave={() => this.changeTrack(currentTrack)} {...otherProps}>
        {tracks.map(t => {
          const active = t.id === currentTrack.id
          const bgIsLight = t.color.isLight

          return (
            <Track
              bg={t.color.value}
              bgIsLight={bgIsLight}
              innerRef={n => (this._track[t.id] = n)}
              key={t.id}
              onMouseEnter={() => canPlay && onSetTrack(t)}
              playing={active && playing}
            >
              <a
                href={`https://open.spotify.com/track/${t.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <TrackContent>
                  <TrackImage>
                    <img src={t.image.small} alt="" />
                  </TrackImage>
                  <Box flow={5}>
                    <TrackName>{t.name}</TrackName>
                    <TrackArtist>{t.artists.join(', ')}</TrackArtist>
                  </Box>
                </TrackContent>
                <TrackIcon bg={t.color.value} active={active}>
                  <IconDisc height={20} width={20} />
                </TrackIcon>
                {playing &&
                  active && (
                    <TrackProgress bgIsLight={bgIsLight} progress={progress} duration={duration} />
                  )}
              </a>
            </Track>
          )
        })}
      </Wrapper>
    )
  }
}

export default ListTracks
