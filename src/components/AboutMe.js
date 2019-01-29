import React from 'react'
import styled from 'styled-components'
import { useSpring, animated } from 'react-spring/hooks.cjs'
import Box from 'meh-components/Box'

import useIsLight from 'hooks/useIsLight'

import HighlightLink from 'components/HighlightLink'
import MediaControls from 'components/MediaControls'

const Container = styled(Box)`
  position: fixed;
  left: 100px;
  top: 100px;
  z-index: 10;

  @media only screen and (max-width: 875px) {
    left: 0;
    right: 0;
    top: 0;
  }
`
const Wrapper = styled(Box).attrs({
  flow: 10,
})`
  height: 110px;
  padding: 20px;
`

const AboutMe = () => {
  const isLight = useIsLight()
  const { color, bg } = useSpring({
    bg: isLight ? 'black' : 'white',
    color: isLight ? 'white' : 'black',
  })
  return (
    <Container>
      <animated.div
        style={{
          height: '100%',
          backgroundColor: bg,
          color,
        }}
      >
        <Wrapper>
          <Box>Hi, I’m Loëck !</Box>
          <Box horizontal flow={5}>
            <Box>I work in Paris at</Box>
            <HighlightLink isLight={isLight} href="https://www.livemon.com">
              LiveMon
            </HighlightLink>
            <Box>as a Lead Frontend Developer.</Box>
          </Box>
          <Box horizontal flow={5}>
            <HighlightLink isLight={isLight} href="https://github.com/loeck">
              Github
            </HighlightLink>
            <Box>/</Box>
            <HighlightLink
              isLight={isLight}
              href="https://www.linkedin.com/in/lo%C3%ABck-v%C3%A9zien-19a0a550"
            >
              LinkedIn
            </HighlightLink>
            <Box>/</Box>
            <HighlightLink isLight={isLight} href="https://www.last.fm/user/NainPuissant">
              Last.fm
            </HighlightLink>
          </Box>
        </Wrapper>
      </animated.div>
      <MediaControls />
    </Container>
  )
}

export default AboutMe
