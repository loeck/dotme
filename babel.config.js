const { NODE_ENV } = process.env

const __DEV__ = NODE_ENV === 'development'

module.exports = {
  presets: [
    '@babel/preset-react',
    [
      '@babel/preset-env',
      {
        loose: true,
        useBuiltIns: 'entry',
        targets: {
          browsers: [
            '> 0.05%',
            'not dead',
            'not ie 11',
            'not ie_mob 11',
            'not android 4.1',
            'not android 4.2',
            'not android 4.4',
            'not android 4.4.3',
            'not chrome 29',
            'not chrome 43',
            'not chrome 49',
            'not chrome 54',
            'not firefox 47',
            'not firefox 48',
            'not firefox 51',
            'not firefox 52',
            'not ios 8.1',
            'not ios 9.3',
            'not safari 5.1',
            'not safari 9.1',
          ],
        },
      },
    ],
  ],
  plugins: [
    'babel-plugin-add-module-exports',
    '@babel/plugin-transform-runtime',
    ['@babel/plugin-proposal-decorators', { legacy: true }],
    ['@babel/plugin-proposal-class-properties', { loose: true }],
    '@babel/plugin-syntax-dynamic-import',
    '@babel/plugin-proposal-export-default-from',
    'babel-plugin-transform-react-remove-prop-types',
    ['babel-plugin-module-resolver', { root: ['src'] }],
    [
      'babel-plugin-styled-components',
      {
        displayName: __DEV__,
      },
    ],
  ],
}
