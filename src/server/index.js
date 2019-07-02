import express from 'express'
import compression from 'compression'
import path from 'path'
import fs from 'fs'

import api from 'server/api'
import render from 'server/render'

const { PORT } = process.env

const server = express()

const stats =
  __ENV__ === 'production'
    ? JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../client/stats.json')).toString())
    : {} // eslint-disable-line import/no-dynamic-require

if (__ENV__ === 'production') {
  server.use(compression())
  server.use('/dist', express.static(path.resolve(__dirname, '../../client')))
}

server.use('/api', api)

server.use(render(stats))

server.listen(PORT, () => {
  console.log(`> http://localhost:${PORT} - ${__ENV__}`) // eslint-disable-line
})
