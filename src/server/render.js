import React from 'react'
import { renderToString, renderToNodeStream } from 'react-dom/server'
import { ServerStyleSheet } from 'styled-components'
import fs from 'fs'
import path from 'path'

import Html from 'components/Html'
import App from 'components/App'

process.noDeprecation = true

const stats =
  __ENV__ === 'production'
    ? JSON.parse(fs.readFileSync(path.resolve(__dirname, './stats.json')).toString())
    : {} // eslint-disable-line import/no-dynamic-require

export default (req, res) => {
  const sheet = new ServerStyleSheet()

  try {
    const content = renderToString(sheet.collectStyles(<App />))
    const styles = sheet.getStyleElement()
    const page = <Html stats={stats} styles={styles} content={content} />

    const stream = sheet.interleaveWithNodeStream(renderToNodeStream(page))

    res.setHeader('Content-Type', 'text/html')
    res.write('<!doctype html>')

    stream.pipe(
      res,
      { end: false },
    )
    stream.on('end', () => res.end())
  } catch (err) {
    res.status(500).send(err.stack)
  } finally {
    sheet.seal()
  }
}
