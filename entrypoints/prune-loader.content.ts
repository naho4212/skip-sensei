import { defineContentScript } from 'wxt/utils/define-content-script'
// Aggressive-mode controller (isolated world): keeps the localStorage flag in
// sync with the setting and relays pruning reports to the activity log. The
// actual MAIN-world pruner (public/prune-main.js) is registered/unregistered
// at runtime by the service worker via chrome.scripting, so it only runs when
// the setting is on. Side-effect import so the message relay is listening
// before the pruner's first report.
import '../src/content/prune-loader'

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  main() {},
})
