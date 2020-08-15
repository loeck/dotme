const path = require('path')
const webpack = require('webpack')

module.exports = {
  stories: ['../src/**/*.stories.js'],
  addons: ['@storybook/addon-links', '@storybook/addon-essentials'],
  webpackFinal: (config) => {
    config.resolve = {
      ...config.resolve,
      modules: [...config.resolve.modules, path.resolve(__dirname, '../src')],
    }

    config.plugins.push(
      // Removing Speedy so the static storybook styling doesn't break
      new webpack.DefinePlugin({
        SC_DISABLE_SPEEDY: true,
      }),
    )

    return config
  },
}
