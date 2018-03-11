import path from 'path'

export default {
  assetsFolder: path.join(__dirname, './assets'),
  distFolder: path.join(__dirname, '../dist'),
  nodeModules: path.resolve(__dirname, '../node_modules'),
  src: path.resolve(__dirname, '../src'),
}
