import express from 'express'
import compression from 'compression'

import api from 'server/api'
import render from 'server/render'

const server = express()

if (__ENV__ === 'production') {
  server.use(compression())
}

server.use('/api', api)
server.use(render)

server.listen()
