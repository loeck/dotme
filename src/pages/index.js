import React from 'react'
import { Helmet } from 'react-helmet'
import { createGlobalStyle } from 'styled-components'

import Home from 'components/Home'

export const style = `
  @import url('https://fonts.googleapis.com/css?family=Fira+Sans:300&display=optional');

  * {
    -webkit-font-smoothing: antialiased;
    background: transparent;
    border: none;
    box-sizing: border-box;
    color: inherit;
    flex-shrink: 0;
    font: inherit;
    margin: 0;
    padding: 0;
  }

  body {
    background: #ffffff;
    font-family: 'Fira Sans', Helvetica, Arial, sans-serif;
    font-weight: 300;
    font-size: 13px;
    overflow: hidden;
  }

  .lazyload,
  .lazyloading {
    opacity: 0;
  }
  .lazyloaded {
    opacity: 1;
    transition: opacity 300ms;
  }
`

export const GlobalStyle = createGlobalStyle`
  ${style}
`

const IndexPage = () => (
  <>
    <GlobalStyle />

    <Helmet>
      <meta charSet="utf-8" />
      <title>loeck.me</title>
      <link rel="canonical" href="https://loeck.me" />
    </Helmet>

    <Home />
  </>
)

export default IndexPage
