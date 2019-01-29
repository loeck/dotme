import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer'
import { StatsWriterPlugin } from 'webpack-stats-plugin'
import merge from 'webpack-merge'
import webpack from 'webpack'

import webpackConfig from './base'

const { BUNDLE_ANALYSER } = process.env

const plugins = [
  new webpack.optimize.ModuleConcatenationPlugin(),

  new StatsWriterPlugin({
    transform: data =>
      JSON.stringify({
        main: data.assetsByChunkName.main,
        vendor: data.assetsByChunkName.vendor,
      }),
  }),
]

if (BUNDLE_ANALYSER) {
  plugins.push(new BundleAnalyzerPlugin())
}

export default merge(webpackConfig, {
  mode: 'production',

  output: {
    filename: '[name]-[chunkhash].js',
  },

  module: {
    rules: [
      {
        test: /\.js$/,
        use: {
          loader: 'babel-loader',
        },
        exclude: /node_modules/,
      },
    ],
  },

  optimization: {
    splitChunks: {
      cacheGroups: {
        vendor: {
          test: /node_modules/,
          chunks: 'initial',
          name: 'vendor',
        },
      },
    },
  },

  plugins,
})
