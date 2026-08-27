import { defineContentScript } from 'wxt/utils/define-content-script'
// Side-effect import: the Spotify audio-ad muter (src/content/audio-ads.ts).
import '../src/content/audio-ads'

export default defineContentScript({
  // The web player only — a browser extension can't reach the desktop or
  // mobile apps. Declared statically: open.spotify.com is inside the
  // all-sites host permission, so this adds no install-time warning, and
  // gates itself at runtime on the same "Block all ads" switch + per-site
  // pause as every other web-blocking layer.
  matches: ['*://open.spotify.com/*'],
  runAt: 'document_idle',
  main() {},
})
