/**
 * A tenth of a second of 8-bit, 8 kHz mono silence as WAV bytes. Served from a blob: URL, which
 * the CSP's `media-src 'self' blob:` allows (a data: URL would be blocked).
 */
function silentWav() {
  const samples = 800
  const bytes = new Uint8Array(44 + samples)
  const view = new DataView(bytes.buffer)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, 8000, true)
  view.setUint32(28, 8000, true) // byte rate
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, samples, true)
  bytes.fill(0x80, 44)
  return new Blob([bytes], { type: 'audio/wav' })
}

/**
 * A media element unlocked for later playback. WebKit only lets an element start sound outside a
 * user gesture once it has played inside one, and the first music piece is due 30–50 s after
 * the click, long after the gesture has expired. Call this synchronously in the enabling click
 * or key handler: it plays a muted tenth of a second of silence and pauses again, and the
 * music later reuses the same element. Returns undefined where media elements are missing.
 */
export function primeMediaElement(): HTMLAudioElement | undefined {
  if (typeof Audio === 'undefined') return undefined
  const element = new Audio()
  element.preload = 'auto'
  element.muted = true
  const url = URL.createObjectURL(silentWav())
  element.src = url
  try {
    // Failure here is expected without a gesture; the music reports its own outcome later.
    void element
      .play()
      .then(() => element.pause())
      .catch(() => {})
      .finally(() => URL.revokeObjectURL(url))
  } catch {
    /* Some engines throw synchronously without a source; playback will report it. */
    URL.revokeObjectURL(url)
  }
  return element
}
