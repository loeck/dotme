import React from 'react'
import styled from 'styled-components'
import { useSpring, animated } from 'react-spring'
import loadable from '@loadable/component'

import useIsLight from 'hooks/useIsLight'
import { mobile } from 'helpers/styles'

import Box from 'components/Box'
import HighlightLink from 'components/HighlightLink'
import LazyImg from 'components/LazyImg'

const MediaControls = loadable(() => import('components/MediaControls'))

const AboutMe = React.memo(({ withMediaControls }) => (
  <Container>
    <InnerAboutMe withMediaControls={withMediaControls} />
  </Container>
))

AboutMe.defaultProps = {
  withMediaControls: true,
}

export const InnerAboutMe = ({ withMediaControls }) => {
  const isLight = useIsLight()
  const { color, bg } = useSpring({
    bg: isLight ? 'black' : 'white',
    color: isLight ? 'white' : 'black',
  })

  return (
    <>
      <InnerContainer
        id="main"
        style={{
          backgroundColor: bg,
          color,
        }}
      >
        <Wrapper>
          <Avatar alt="Github Avatar" src="https://github.com/loeck.png?size=70" />
          <InnerWrapper>
            <Box>Hi, I’m Loëck !</Box>
            <Box horizontal flow={5}>
              <Box>I work in Paris at</Box>
              <HighlightLink isLight={isLight} href="https://www.join-jump.com/">
                Jump
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
                href="https://linkedin.com/in/lo%C3%ABck-v%C3%A9zien-19a0a550"
              >
                LinkedIn
              </HighlightLink>
              <Box>/</Box>
              <HighlightLink isLight={isLight} href="https://last.fm/user/NainPuissant">
                Last.fm
              </HighlightLink>
            </Box>
          </InnerWrapper>
        </Wrapper>
      </InnerContainer>
      {withMediaControls && <MediaControls />}
    </>
  )
}

export default AboutMe

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
const InnerContainer = styled(animated.main)`
  height: 100%;
  position: relative;
  z-index: 1;
`
const Wrapper = styled(Box).attrs({
  flow: 10,
  horizontal: true,
})`
  height: 110px;
  pointer-events: auto;
  padding: 20px;
`
const InnerWrapper = styled(Box)`
  justify-content: space-around;
`
const Avatar = styled(LazyImg)`
  border-radius: 50%;
  height: 100%;
  width: 70px;
`
