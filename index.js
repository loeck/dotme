require('dotenv').config()

require('@babel/register')
require('@babel/polyfill')

const globals = require('./src/globals')

Object.keys(globals).forEach(key => (global[key] = globals[key]))

require('./src/server')
