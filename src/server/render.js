import React from 'react'
import { renderToString, renderToNodeStream } from 'react-dom/server'
import axios from 'axios'
import { ServerStyleSheet } from 'styled-components'

import Html from 'components/Html'
import App from 'components/App'

const { API_URL } = process.env

export default stats => async (req, res) => {
  try {
    const sheet = new ServerStyleSheet()

    const { data: tracks } = await axios.get(`${API_URL}/spotify`)

    const state = {
      tracks,
    }

    const Component = App(state)

    const content = renderToString(sheet.collectStyles(Component))
    const styles = __DEV__ ? '' : sheet.getStyleElement()
    const page = <Html stats={stats} state={state} styles={styles} content={content} />

    const stream = sheet.interleaveWithNodeStream(renderToNodeStream(page))

    res.write('<!doctype html>')

    stream.pipe(res, { end: false })
    stream.on('end', () => res.end())
  } catch (err) {
    res.status(500).send(err.stack)
  }
}
