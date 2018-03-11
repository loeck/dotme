export function getProxyUrl(url) {
  if (!url || url === null) {
    return null
  }

  return `/proxy?${url}`
}
