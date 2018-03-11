import React from 'react'
import styled from 'styled-components'

import Box from 'meh-components/Box'

import IconPlay from 'icons/Play'
import IconPause from 'icons/Pause'
import IconSoundHigh from 'icons/SoundHigh'
import IconSoundLow from 'icons/SoundLow'

const Wrapper = styled(Box).attrs({
  align: 'center',
  horizontal: true,
})`
  color: ${p => (p.bgIsLight ? 'black' : 'white')};
  position: fixed;
  top: 220px;
  left: 100px;
  transition: all ease-in-out 0.1s;
  user-select: none;
  z-index: 3;

  svg {
    cursor: pointer;
  }
`

const Footer = ({ bgIsLight, volume, playing, onTogglePlaying, onChangeVolume }) => (
  <Wrapper bgIsLight={bgIsLight} flow={10}>
    {playing ? (
      <IconPause height={16} width={16} onClick={() => onTogglePlaying(false)} />
    ) : (
      <IconPlay height={16} width={16} onClick={() => onTogglePlaying(true)} />
    )}
    {volume === 1 ? (
      <IconSoundHigh height={18} width={18} onClick={() => onChangeVolume(0.1)} />
    ) : (
      <IconSoundLow height={17} width={17} onClick={() => onChangeVolume(1)} />
    )}
  </Wrapper>
)

export default Footer
