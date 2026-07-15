import { defineBackground } from 'wxt/utils/define-background'
// Side-effect import, NOT lazy: the service worker registers all of its
// chrome.* event listeners at module evaluation, which MV3 requires to happen
// synchronously in the worker's first turn. Static imports are hoisted above
// main(), so the timing is identical to the pre-WXT bundle.
import '../src/service-worker'

export default defineBackground({
  type: 'module',
  main() {},
})
