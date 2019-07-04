import React from 'react'
import { renderToString, renderToNodeStream } from 'react-dom/server'
import axios from 'axios'
import { ServerStyleSheet } from 'styled-components'
import fs from 'fs'
import path from 'path'

import Html from 'components/Html'
import App from 'components/App'

const stats =
  __ENV__ === 'production'
    ? JSON.parse(fs.readFileSync(path.resolve(__dirname, './stats.json')).toString())
    : {} // eslint-disable-line import/no-dynamic-require

export default async (req, res) => {
  const sheet = new ServerStyleSheet()

  const urlHost = req.headers['x-now-deployment-url']
  const urlProtocol = urlHost.includes('localhost') ? 'http' : 'https'

  try {
    const { data: tracks } = await axios.get(`${urlProtocol}://${urlHost}/api/spotify`)

    const state = {
      tracks,
    }

    const Component = App(state)

    const content = renderToString(sheet.collectStyles(Component))
    const styles = __DEV__ ? '' : sheet.getStyleElement()
    const page = <Html stats={stats} state={state} styles={styles} content={content} />

    const stream = sheet.interleaveWithNodeStream(renderToNodeStream(page))

    res.header('Content-Type', 'text/html')
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
