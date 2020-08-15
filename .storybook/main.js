const path = require('path')

module.exports = {
  stories: ['../src/**/*.stories.js'],
  addons: ['@storybook/addon-links', '@storybook/addon-essentials'],
  webpackFinal: (config) => {
    config.resolve = {
      ...config.resolve,
      modules: [...config.resolve.modules, path.resolve(__dirname, '../src')],
    }

    return config
  },
}
