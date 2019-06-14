import express from 'express'
import compression from 'compression'
import path from 'path'

import api from 'server/api'
import render from 'server/render'

import paths from '../paths'

const { PORT } = process.env

const server = express()

const stats = __ENV__ === 'production' ? require(path.join(paths.distFolder, 'stats.json')) : {} // eslint-disable-line import/no-dynamic-require

if (__ENV__ === 'development') {
  require('./webpack').default(server)
}

if (__ENV__ === 'production') {
  server.use(compression())
  server.use('/dist', express.static(paths.distFolder))
}

server.use('/assets', express.static(paths.assetsFolder))
server.use('/api', api)

server.use(render(stats))

server.listen(PORT, () => {
  console.log(`> http://localhost:${PORT} - ${__ENV__}`) // eslint-disable-line
})
