import { defineContentScript } from 'wxt/utils/define-content-script'
// Side-effect import: cosmetic hiding at document_start, before first paint.
import '../src/content/cosmetic'

export default defineContentScript({
  // Cosmetic filtering. Declared statically for youtube.com ONLY — YouTube
  // display-ad hiding is a default-on feature and youtube.com access is a
  // required permission, so this needs no opt-in and adds no install-time
  // warning. Applying the SAME script to the rest of the web is the opt-in
  // "Block all ads" path: the service worker registers this entrypoint's built
  // file at runtime on *://*/* (see src/cosmetic-register.ts, which reads the
  // file name back from this manifest entry) once the user enables a
  // web-cosmetic feature and grants the optional all-sites permission. Keeping
  // the broad match OUT of the manifest is what keeps the base install
  // YouTube-scoped.
  //
  // NOTE: keep "cosmetic" in this entrypoint's filename — cosmetic-register.ts
  // finds the built file by matching /cosmetic/ against manifest js paths.
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_start',
  allFrames: true,
  main() {},
})
