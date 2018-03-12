import React from 'react'

import PropTypes from 'prop-types'
import serialize from 'serialize-javascript'

import webpackConfig from '../../webpack/base'

const Html = ({
  content,
  lang,
  state,
  styles,
  stats: { main = webpackConfig.output.filename, vendor },
  title,
}) => (
  <html lang={lang}>
    <head>
      <title>{title}</title>
      <meta charSet="utf-8" />
      <meta httpEquiv="x-ua-compatible" content="ie=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/assets/favicon.ico" type="image/x-icon" />
      <link href="https://fonts.googleapis.com/css?family=Fira+Sans:300,400" rel="stylesheet" />
      {styles}
      <script
        dangerouslySetInnerHTML={{ __html: `window.__INITIAL_STATE__ = ${serialize(state)}` }} // eslint-disable-line react/no-danger
      />
    </head>
    <body>
      <div
        id="root"
        dangerouslySetInnerHTML={{ __html: content }} // eslint-disable-line react/no-danger
      />
      {vendor && <script src={`/dist/${vendor}`} />}
      <script src={`/dist/${main}`} />
    </body>
  </html>
)

Html.defaultProps = {
  content: '',
  lang: 'en',
  state: {},
  stats: {},
  styles: null,
  title: 'loeck.me',
}

Html.propTypes = {
  content: PropTypes.string,
  lang: PropTypes.string,
  state: PropTypes.object,
  stats: PropTypes.shape({
    main: PropTypes.string,
    vendor: PropTypes.string,
  }),
  styles: PropTypes.node,
  title: PropTypes.string,
}

export default Html
