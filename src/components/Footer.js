import React from 'react'
import styled from 'styled-components'

import Box from 'meh-components/Box'

import IconPlay from 'icons/Play'
import IconPause from 'icons/Pause'
import IconNext from 'icons/Next'

const Wrapper = styled(Box).attrs({
  align: 'center',
  horizontal: true,
})`
  color: ${p => (p.bgIsLight ? 'black' : 'white')};
  margin-top: 10px;
  position: relative;
  transition: all ease-in-out 0.1s;
  user-select: none;
  z-index: 3;

  svg {
    cursor: pointer;
  }
`

const Footer = ({ bgIsLight, playing, onTogglePlaying, onChangeTrack }) => (
  <Wrapper bgIsLight={bgIsLight} flow={10}>
    {playing ? (
      <IconPause height={16} width={16} onClick={() => onTogglePlaying(false)} />
    ) : (
      <IconPlay height={16} width={16} onClick={() => onTogglePlaying(true)} />
    )}
    {playing && <IconNext height={16} width={16} onClick={onChangeTrack} />}
  </Wrapper>
)

export default Footer
