import webpack from 'webpack'
import merge from 'webpack-merge'

import webpackConfig from './base'

export default merge(webpackConfig, {
  mode: 'development',

  devtool: 'eval',

  entry: {
    app: ['react-hot-loader/patch', ...webpackConfig.entry, 'webpack-hot-middleware/client'],
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

  plugins: [new webpack.HotModuleReplacementPlugin(), new webpack.NoEmitOnErrorsPlugin()],
})
