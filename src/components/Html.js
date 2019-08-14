/* eslint-disable react/no-danger */

import React from 'react'

const { GOOGLE_ANALYTICS } = process.env

const Html = ({ content, lang, styles, title }) => (
  <html lang={lang}>
    <head>
      <title>{title}</title>
      <meta charSet="utf-8" />
      <meta httpEquiv="x-ua-compatible" content="ie=edge" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/dist/assets/favicon.ico" type="image/x-icon" />
      {styles}
    </head>
    <body>
      <div id="root" dangerouslySetInnerHTML={{ __html: content }} />

      <script src="/dist/manifest.js" async />
      <script src="/dist/vendor.js" async />
      <script src="/dist/main.js" async />

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
  stats: {},
  styles: null,
  title: 'loeck.me',
}

export default Html
