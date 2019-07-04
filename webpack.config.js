const { StatsWriterPlugin } = require('webpack-stats-plugin')
const CopyPlugin = require('copy-webpack-plugin')
const Dotenv = require('dotenv-webpack')
const nodeExternals = require('webpack-node-externals')
const TerserPlugin = require('terser-webpack-plugin')
const webpack = require('webpack')

const paths = require('./src/paths')

const { DEBUG, NODE_ENV } = process.env

const globals = {
  __DEBUG__: !!DEBUG,
  __ENV__: NODE_ENV || 'development',
  __DEV__: NODE_ENV === 'development',
}

const isEnvProduction = globals.__ENV__ === 'production'
const isEnvDevelopment = globals.__DEV__

const makeWebpackConfig = minimize => ({
  mode: isEnvProduction ? 'production' : isEnvDevelopment && 'development',
  bail: isEnvProduction,

  stats: 'errors-only',
  performance: false,

  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        loader: 'babel-loader',
        options: {
          cacheCompression: isEnvProduction,
          cacheDirectory: true,
          compact: isEnvProduction,
        },
      },
    ],
  },

  optimization: minimize
    ? {
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
      }
    : {},
})

const makeDefinePlugin = browser =>
  new webpack.DefinePlugin({
    ...Object.keys(globals).reduce((acc, key) => {
      acc[key] = JSON.stringify(globals[key])
      return acc
    }, {}),
    __BROWSER__: JSON.stringify(browser),
    'process.env.NODE_ENV': JSON.stringify(globals.__ENV__),
  })

module.exports = [
  {
    ...makeWebpackConfig(true),

    target: 'web',

    entry: ['@babel/polyfill', './src/client'],

    output: {
      chunkFilename: '[name].[chunkhash].js',
      filename: '[name].[hash].js',
      path: `${paths.distFolder}/client`,
      pathinfo: isEnvDevelopment,
      publicPath: '/dist/',
    },

    plugins: [
      new Dotenv(),

      makeDefinePlugin(true),

      new StatsWriterPlugin({
        filename: '../server/stats.json',
        transform: data =>
          JSON.stringify({
            manifest: data.assetsByChunkName.manifest,
            vendor: data.assetsByChunkName.vendor,
            main: data.assetsByChunkName.main,
          }),
      }),

      new CopyPlugin([{ from: 'src/assets', to: `${paths.distFolder}/client/assets` }]),
    ],
  },

  {
    ...makeWebpackConfig(false),

    target: 'node',
    node: {
      __dirname: false,
      __filename: false,
    },

    entry: ['@babel/polyfill', './src/server'],

    externals: [nodeExternals()],

    output: {
      libraryTarget: 'umd',
      filename: '[name].js',
      path: `${paths.distFolder}/server`,
    },

    plugins: [new Dotenv(), makeDefinePlugin(false)],
  },
]
