import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer'
import { StatsWriterPlugin } from 'webpack-stats-plugin'
import merge from 'webpack-merge'
import UglifyJSPlugin from 'uglifyjs-webpack-plugin'
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
    minimizer: [
      new UglifyJSPlugin({
        uglifyOptions: {
          compress: true,
          ecma: 8,
          ie8: false,
          keep_fnames: false,
          mangle: true,
          nameCache: null,
          output: {
            comments: false,
            beautify: false,
          },
          safari10: false,
          toplevel: false,
          warnings: false,
        },
      }),
    ],
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
