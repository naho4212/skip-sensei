import { defineContentScript } from 'wxt/utils/define-content-script'
// Side-effect import: the ad engine must start polling for the player at
// script evaluation. On a cold watch-page load the pre-roll starts playing
// seconds before document_idle fires, so the engine must already be running
// by then — that's also why this runs at document_start.
import '../src/content/index'

export default defineContentScript({
  // Match all of youtube.com, not just /watch*: YouTube is an SPA, so a
  // user landing on the homepage and clicking a video never triggers a new
  // page load. The script gates itself to watch pages at runtime.
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  main() {},
})
