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
  position: fixed;
  top: 225px;
  left: 105px;
  transition: all ease-in-out 0.1s;
  user-select: none;
  z-index: 3;

  @media only screen and (max-width: 875px) {
    left: 20px;
  }

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
