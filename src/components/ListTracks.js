import React, { PureComponent } from 'react'
import styled from 'styled-components'
import Color from 'color'

import Box from 'meh-components/Box'

const Wrapper = styled(Box)`
  margin-left: 50%;
  padding: 100px 50px;
  position: relative;
  width: 50%;
  z-index: 2;
`
const Track = styled(Box).attrs({
  style: p => ({
    background: p.bg || 'black',
  }),
})`
  color: ${p => (new Color(p.bg).isLight() ? 'black' : 'white')};
  padding: 20px;
  overflow: hidden;
  position: relative;
  transition: all ease-in-out 0.1s;
  user-select: none;

  &:after {
    background: rgba(${p => (new Color(p.bg).isLight() ? '0, 0, 0' : '255, 255, 255')}, 0.5);
    content: ' ';
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    right: ${p => (p.playing ? 0 : '100%')};
    transition: right linear ${p => (p.playing ? p.duration : 0)}s;
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
    const { tracks, currentTrack, onSetTrack, duration } = this.props

    return (
      <Wrapper onMouseLeave={() => onSetTrack({})}>
        {tracks.map(t => (
          <Track
            innerRef={n => (this._track[t.id] = n)}
            bg={t.color}
            duration={duration}
            key={t.id}
            onMouseEnter={() => onSetTrack(t)}
            playing={t.id === currentTrack.id}
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
          </Track>
        ))}
      </Wrapper>
    )
  }
}

export default ListTracks
