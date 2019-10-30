import React from 'react'
import styled from 'styled-components'
import { useSpring, animated } from 'react-spring'
import loadable from '@loadable/component'

import useIsLight from 'hooks/useIsLight'
import { mobile } from 'helpers/styles'

import Box from 'components/Box'
import HighlightLink from 'components/HighlightLink'

const MediaControls = loadable(() => import('components/MediaControls'))

const Container = styled(Box)`
  position: fixed;
  pointer-events: none;
  left: 110px;
  top: 110px;
  z-index: 10;

  ${mobile`
    left: 0;
    right: 0;
    top: 0;
  `}
`
const InnerContainer = styled(animated.div)`
  height: 100%;
  position: relative;
  z-index: 1;
`
const Wrapper = styled(Box).attrs({
  flow: 10,
})`
  height: 110px;
  pointer-events: auto;
  padding: 20px;
`

const AboutMe = React.memo(() => {
  const isLight = useIsLight()
  const { color, bg } = useSpring({
    bg: isLight ? 'black' : 'white',
    color: isLight ? 'white' : 'black',
  })

  return (
    <Container>
      <InnerContainer
        style={{
          backgroundColor: bg,
          color,
        }}
      >
        <Wrapper>
          <Box>Hi, I’m Loëck !</Box>
          <Box horizontal flow={5}>
            <Box>I work in Paris at</Box>
            <HighlightLink isLight={isLight} href="https://hivebrite.com">
              Hivebrite
            </HighlightLink>
            <Box>as an Lead Frontend Developer.</Box>
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
      </InnerContainer>
      <MediaControls />
    </Container>
  )
})

export default AboutMe
