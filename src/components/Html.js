/* eslint-disable react/no-danger */

import React from 'react'

import PropTypes from 'prop-types'
import serialize from 'serialize-javascript'

import webpackConfig from '../../webpack/base'

const { GOOGLE_ANALYTICS } = process.env

const Html = ({
  content,
  lang,
  state,
  styles,
  stats: { main = webpackConfig.output.filename, vendor, manifest },
  title,
}) => (
  <html lang={lang}>
    <head>
      <title>{title}</title>
      <meta charSet="utf-8" />
      <meta httpEquiv="x-ua-compatible" content="ie=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/assets/favicon.ico" type="image/x-icon" />
      <link
        href="https://fonts.googleapis.com/css?family=Fira+Sans:300&display=optional"
        rel="stylesheet"
      />
      {styles}
      <script
        dangerouslySetInnerHTML={{ __html: `window.__INITIAL_STATE__ = ${serialize(state)}` }} // eslint-disable-line react/no-danger
      />
    </head>
    <body>
      <div id="root" dangerouslySetInnerHTML={{ __html: content }} />
      {manifest && <script src={`/dist/${manifest}`} />}
      {vendor && <script src={`/dist/${vendor}`} />}
      <script src={`/dist/${main}`} />
      {GOOGLE_ANALYTICS && (
        <div
          dangerouslySetInnerHTML={{
            __html: `
              <script async src="https://www.googletagmanager.com/gtag/js?id=UA-115579585-1"></script>
              <script>
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${GOOGLE_ANALYTICS}');
              </script>
            `,
          }}
        />
      )}
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
