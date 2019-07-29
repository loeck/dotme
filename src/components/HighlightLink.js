import React from 'react'
import { useSpring, animated } from 'react-spring'
import styled from 'styled-components'

const Wrapper = styled(animated.a)`
  display: inline-flex;
  margin-top: -3px;
  padding: 3px;
  text-decoration: none;
`

const HighlightLink = React.memo(props => {
  const { isLight, href, children } = props

  const { bg, color } = useSpring({
    bg: isLight ? 'white' : 'black',
    color: isLight ? 'black' : 'white',
  })

  return (
    <Wrapper
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        backgroundColor: bg,
        color,
      }}
    >
      {children}
    </Wrapper>
  )
})

export default HighlightLink
