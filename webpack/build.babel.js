import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer'
import { StatsWriterPlugin } from 'webpack-stats-plugin'
import merge from 'webpack-merge'
import webpack from 'webpack'
import TerserPlugin from 'terser-webpack-plugin'

import webpackConfig from './base'

const { BUNDLE_ANALYSER } = process.env

const plugins = [
  new StatsWriterPlugin({
    transform: data =>
      JSON.stringify({
        main: data.assetsByChunkName.main,
        vendor: data.assetsByChunkName.vendor,
      }),
  }),

  new webpack.HashedModuleIdsPlugin(),
]

if (BUNDLE_ANALYSER) {
  plugins.push(new BundleAnalyzerPlugin())
}

export default merge(webpackConfig, {
  mode: 'production',

  output: {
    filename: '[name]-[contenthash].js',
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
    minimize: true,
    minimizer: [
      new TerserPlugin({
        cache: true,
        parallel: true,
        sourceMap: true,
        exclude: /\.min\.js/,
        terserOptions: {
          ie8: false,
          mangle: {
            safari10: true,
          },
          parse: {
            ecma: 8,
          },
          compress: {
            drop_console: true,
            ecma: 5,
          },
          output: {
            ecma: 5,
          },
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
        chunks: 'all',
      },
    },
    runtimeChunk: {
      name: 'manifest',
    },
  },

  plugins,
})
