import React from 'react'
import styled from 'styled-components'

import Box from 'meh-components/Box'

const Wrapper = styled(Box)`
  color: ${p => (p.bgIsLight ? 'white' : 'black')};
  background: ${p => (p.bgIsLight ? 'black' : 'white')};
  position: relative;
  padding: 20px;
  transition: all ease-in-out 0.1s;
  user-select: none;
  z-index: 2;

  a {
    background: ${p => (p.bgIsLight ? 'white' : 'black')};
    color: ${p => (p.bgIsLight ? 'black' : 'white')};
    display: inline-block;
    padding: 2px;
    margin: -2px 0;
    text-decoration: none;
    transition: all ease-in-out 0.1s;
  }
`

const Me = ({ bgIsLight }) => (
  <Wrapper bgIsLight={bgIsLight} flow={10}>
    <div>Hi, I&apos;m Loëck !</div>
    <div>
      I work in Paris at{' '}
      <a href="https://ledger.fr" target="_blank" rel="noopener noreferrer">
        Ledger
      </a>{' '}
      as a Senior Front-end Developer.
    </div>
    <div>
      <a href="https://github.com/loeck" target="_blank" rel="noopener noreferrer">
        Github
      </a>{' '}
      /{' '}
      <a
        href="https://linkedin.com/in/lo%C3%ABck-v%C3%A9zien-19a0a550/"
        target="_blank"
        rel="noopener noreferrer"
      >
        LinkedIn
      </a>{' '}
      /{' '}
      <a href="https://www.last.fm/user/NainPuissant" target="_blank" rel="noopener noreferrer">
        Last.fm
      </a>
    </div>
  </Wrapper>
)

export default Me
