module.exports = {
  siteMetadata: {
    title: 'loeck.me',
    author: 'Loëck Vézien',
  },
  plugins: [
    {
      resolve: 'gatsby-plugin-styled-components',
      options: {
        displayName: false,
      },
    },
    {
      resolve: 'gatsby-plugin-favicon',
      options: {
        logo: './src/assets/favicon.png',
      },
    },
  ],
}
