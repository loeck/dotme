import Dotenv from 'dotenv-webpack'
import path from 'path'
import webpack from 'webpack'

import paths from 'paths'
import config from 'config'
import * as globals from 'globals'

export default {
  entry: ['@babel/polyfill', './src/client'],

  resolve: {
    modules: [paths.src, paths.nodeModules],
  },

  output: {
    path: `${paths.distFolder}`,
    filename: 'bundle.js',
    publicPath: '/dist/',
  },

  module: {
    rules: [
      {
        test: /\.(jpe?g|png|gif|svg)$/i,
        use: [
          {
            loader: 'file-loader',
            options: {
              hash: 'sha512',
              digest: 'hex',
              name: `${config.imagesFolder}/[hash].[ext]`,
            },
          },
        ],
      },
      {
        test: /\.woff(2)?(\?v=[0-9]\.[0-9]\.[0-9])?$/,
        use: [
          {
            loader: 'url-loader',
            options: {
              limit: 8192,
              minetype: 'application/font-woff',
              name: `${config.fontsFolder}/[hash].[ext]`,
            },
          },
        ],
        include: path.normalize(`${paths.src}/${config.fontsFolder}`),
      },
      {
        test: /\.(ttf|eot)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
        use: [
          {
            loader: 'file-loader',
            options: {
              name: `${config.fontsFolder}/[hash].[ext]`,
            },
          },
        ],
        include: path.normalize(`${paths.src}/${config.fontsFolder}`),
      },
    ],
  },

  plugins: [
    new Dotenv(),

    new webpack.DefinePlugin({
      ...Object.keys(globals).reduce((acc, key) => {
        acc[key] = JSON.stringify(globals[key])
        return acc
      }, {}),
      __BROWSER__: JSON.stringify(true),
      'process.env.NODE_ENV': JSON.stringify(globals.__ENV__),
    }),
  ],
}
