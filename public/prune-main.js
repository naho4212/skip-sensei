/**
 * Aggressive-mode pruner — runs in the PAGE (MAIN) world at document_start,
 * registered directly in the manifest with "world": "MAIN" so it executes
 * SYNCHRONOUSLY before YouTube's first inline script sets
 * ytInitialPlayerResponse. (A content script injected from the isolated
 * world can't do this: the CRXJS module loader imports asynchronously and
 * lands too late for the initial page load.)
 *
 * It strips ad slots out of YouTube player responses (uBO "json-prune"), so
 * most ads never start. It's only injected when aggressive mode is on: the
 * service worker registers/unregisters it at runtime via chrome.scripting,
 * so registration itself is the gate — no in-script flag check needed.
 *
 * This file is intentionally plain ES5-ish JS with no imports: it's copied
 * verbatim from public/ and injected as-is into the page.
 */
;(function () {
  'use strict'
  if (window.__skipSenseiPruned) return
  window.__skipSenseiPruned = true

  var AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams']
  var lastNotify = 0

  function notify() {
    var now = Date.now()
    if (now - lastNotify < 1000) return
    lastNotify = now
    try {
      window.postMessage({ source: 'skip-sensei', type: 'ads-pruned' }, '*')
    } catch (e) {}
  }

  function prune(obj) {
    if (!obj || typeof obj !== 'object') return obj
    var hit = false
    for (var i = 0; i < AD_KEYS.length; i++) {
      if (AD_KEYS[i] in obj) {
        try {
          delete obj[AD_KEYS[i]]
          hit = true
        } catch (e) {}
      }
    }
    // Some shapes nest the payload under playerResponse.
    if (obj.playerResponse && typeof obj.playerResponse === 'object') {
      for (var j = 0; j < AD_KEYS.length; j++) {
        if (AD_KEYS[j] in obj.playerResponse) {
          try {
            delete obj.playerResponse[AD_KEYS[j]]
            hit = true
          } catch (e) {}
        }
      }
    }
    if (hit) notify()
    return obj
  }

  // 1) Initial watch-page payload: an inline script assigns
  //    window.ytInitialPlayerResponse. Trap the assignment.
  var stored
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: function () {
        return stored
      },
      set: function (value) {
        stored = prune(value)
      },
    })
  } catch (e) {}

  // 2) SPA navigations / autoplay: the player response arrives via
  //    fetch().json().
  var originalJson = Response.prototype.json
  Response.prototype.json = function () {
    return originalJson.apply(this, arguments).then(function (data) {
      return prune(data)
    })
  }

  // 3) Belt and braces for anything parsed out-of-band.
  var originalParse = JSON.parse
  JSON.parse = function () {
    return prune(originalParse.apply(this, arguments))
  }
})()
