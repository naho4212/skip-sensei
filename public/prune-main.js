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

  // ---------------------------------------------------------------------------
  // 0) Native-function cloaking (CRITICAL — set up first; every native-function
  //    replacement below is routed through cloak() so that integrity checks of
  //    the form `fn.toString().includes('[native code]')` still see the
  //    original native source and don't detect our tampering.
  //
  //    Implementation: patch Function.prototype.toString ONCE. A WeakMap maps
  //    each replacement function -> the ORIGINAL native it stands in for; when
  //    toString is invoked on a known replacement we return the ORIGINAL's
  //    toString output instead. The patched toString cloaks itself too.
  // ---------------------------------------------------------------------------
  var nativeToString = Function.prototype.toString
  var cloakMap
  try {
    cloakMap = new WeakMap()
  } catch (e) {
    cloakMap = null
  }

  function cloak(replacementFn, originalFn) {
    try {
      if (cloakMap && typeof replacementFn === 'function' && typeof originalFn === 'function') {
        cloakMap.set(replacementFn, originalFn)
      }
    } catch (e) {}
    return replacementFn
  }

  try {
    var patchedToString = function toString() {
      try {
        if (cloakMap) {
          var orig = cloakMap.get(this)
          if (orig) return nativeToString.call(orig)
        }
      } catch (e) {}
      return nativeToString.apply(this, arguments)
    }
    Function.prototype.toString = patchedToString
    // Cloak the cloaker itself so Function.prototype.toString.toString()
    // still reports native code.
    cloak(patchedToString, nativeToString)
  } catch (e) {}

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
  try {
    var originalJson = Response.prototype.json
    Response.prototype.json = cloak(function () {
      return originalJson.apply(this, arguments).then(function (data) {
        return prune(data)
      })
    }, originalJson)
  } catch (e) {}

  // 3) Belt and braces for anything parsed out-of-band.
  var originalParse = JSON.parse
  try {
    JSON.parse = cloak(function () {
      return prune(originalParse.apply(this, arguments))
    }, originalParse)
  } catch (e) {}

  // ---------------------------------------------------------------------------
  // 4) Outbound player-request context spoof.
  //    YouTube asks for ad-bearing player responses via POST to
  //    /youtubei/v1/player. We intercept the OUTBOUND request body (fetch +
  //    XHR) and set context.client.clientScreen = "CHANNEL", which nudges
  //    YouTube toward an ad-free response variant. (We use CHANNEL, not EMBED:
  //    EMBED enforces per-video embed permissions and would break playback of
  //    embedding-disabled videos; CHANNEL is a WEB sub-context with no such
  //    restriction.) Only player requests are
  //    touched; everything else passes through byte-for-byte. If anything
  //    fails to parse we forward the ORIGINAL body untouched — we never drop
  //    or corrupt a request.
  // ---------------------------------------------------------------------------
  var PLAYER_PATH = '/youtubei/v1/player'

  function isPlayerUrl(url) {
    try {
      return typeof url === 'string' && url.indexOf(PLAYER_PATH) !== -1
    } catch (e) {
      return false
    }
  }

  function spoofPlayerBody(body) {
    // Only string bodies are handled; anything else is returned as-is.
    if (typeof body !== 'string' || !body) return body
    try {
      var data = originalParse(body)
      if (!data || typeof data !== 'object') return body
      if (!data.context || typeof data.context !== 'object') data.context = {}
      if (!data.context.client || typeof data.context.client !== 'object') {
        data.context.client = {}
      }
      data.context.client.clientScreen = 'CHANNEL'
      return JSON.stringify(data)
    } catch (e) {
      // Parse/serialize failure — forward the original body unchanged.
      return body
    }
  }

  // 4a) fetch()
  try {
    var originalFetch = window.fetch
    if (typeof originalFetch === 'function') {
      window.fetch = cloak(function (input, init) {
        try {
          var url = ''
          if (typeof input === 'string') url = input
          else if (input && typeof input.url === 'string') url = input.url

          if (isPlayerUrl(url) && init && typeof init.body === 'string') {
            var spoofed = spoofPlayerBody(init.body)
            if (spoofed !== init.body) {
              // Shallow-clone init so we don't mutate the caller's object.
              var newInit = {}
              for (var k in init) {
                if (Object.prototype.hasOwnProperty.call(init, k)) newInit[k] = init[k]
              }
              newInit.body = spoofed
              return originalFetch.call(this, input, newInit)
            }
          }
        } catch (e) {}
        return originalFetch.apply(this, arguments)
      }, originalFetch)
    }
  } catch (e) {}

  // 4b) XMLHttpRequest — track the URL on open(), spoof the body on send().
  try {
    var originalOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = cloak(function (method, url) {
      try {
        this.__ssUrl = url
      } catch (e) {}
      return originalOpen.apply(this, arguments)
    }, originalOpen)
  } catch (e) {}

  // The send() wrapper (both body spoof AND responseText shadow) lives in a
  // single override at the end of this file so cloaking stays clean — see the
  // "XHR send" block below.

  // ---------------------------------------------------------------------------
  // 5) HLS ad-segment pruning (m3u-prune) &
  // 6) DASH/VAST XML pruning (xml-prune).
  //    Both operate on the response-TEXT path. We wrap Response.prototype.text
  //    and shadow the per-instance XHR responseText getter, then dispatch on
  //    the body shape: HLS playlists (#EXTM3U) go to m3uPrune, XML bodies
  //    (<?xml / <MPD / <VAST) go to xmlPrune. Both are deliberately
  //    conservative — if no ad markers are recognized the body is returned
  //    byte-for-byte unchanged, so non-ad media is never corrupted.
  // ---------------------------------------------------------------------------

  // 5) HLS playlist ad stripping.
  function m3uPrune(text) {
    try {
      var lines = text.split('\n')
      var out = []
      var changed = false
      var inAdCue = false
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        var t = line.trim()

        // #EXT-X-CUE-OUT ... #EXT-X-CUE-IN brackets a server-stitched ad span;
        // drop the markers and every #EXTINF segment line between them.
        if (/^#EXT-X-CUE-OUT/i.test(t)) {
          inAdCue = true
          changed = true
          continue
        }
        if (/^#EXT-X-CUE-IN/i.test(t)) {
          inAdCue = false
          changed = true
          continue
        }
        if (inAdCue) {
          changed = true
          continue
        }

        // #EXT-X-DATERANGE lines explicitly tagged as ads (stitched-ad CLASS,
        // SCTE-35 cue, or a ",ad" attribute marker).
        if (
          /^#EXT-X-DATERANGE/i.test(t) &&
          /(CLASS="[^"]*ad[^"]*"|twitch-stitched-ad|SCTE35|SCTE-35|,ad(,|"|$))/i.test(t)
        ) {
          changed = true
          continue
        }

        out.push(line)
      }
      if (changed) {
        notify()
        return out.join('\n')
      }
    } catch (e) {}
    return text
  }

  // 6) DASH / VAST XML ad stripping.
  function xmlPrune(text) {
    try {
      if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
        return text
      }
      var doc = new DOMParser().parseFromString(text, 'application/xml')
      // Bail out on any parse error — never risk corrupting non-ad XML.
      if (!doc || doc.getElementsByTagName('parsererror').length) return text
      var root = doc.documentElement
      if (!root) return text
      var name = (root.nodeName || '').toUpperCase()

      // VAST: an <Ad>-bearing wrapper is entirely ad payload; replace it with
      // an empty <VAST> so no ad is served.
      if (name === 'VAST') {
        var ads = doc.getElementsByTagName('Ad')
        if (ads && ads.length) {
          var version = root.getAttribute('version') || '4.0'
          notify()
          return '<VAST version="' + version + '"/>'
        }
        return text
      }

      // DASH MPD: remove <Period> elements that are ad periods — id contains
      // "ad", or a SupplementalProperty signals an ad.
      if (name === 'MPD') {
        var periods = root.getElementsByTagName('Period')
        var toRemove = []
        for (var p = 0; p < periods.length; p++) {
          var period = periods[p]
          var isAd = false
          var id = (period.getAttribute('id') || '').toLowerCase()
          if (id.indexOf('ad') !== -1) isAd = true
          if (!isAd) {
            var supps = period.getElementsByTagName('SupplementalProperty')
            for (var s = 0; s < supps.length; s++) {
              var sig = (
                (supps[s].getAttribute('schemeIdUri') || '') +
                ' ' +
                (supps[s].getAttribute('value') || '')
              ).toLowerCase()
              if (sig.indexOf('ad') !== -1) {
                isAd = true
                break
              }
            }
          }
          if (isAd) toRemove.push(period)
        }
        if (toRemove.length) {
          for (var r = 0; r < toRemove.length; r++) {
            if (toRemove[r].parentNode) toRemove[r].parentNode.removeChild(toRemove[r])
          }
          notify()
          return new XMLSerializer().serializeToString(doc)
        }
        return text
      }
    } catch (e) {}
    return text
  }

  // Dispatch a response-text body to the right pruner by shape.
  function processResponseText(text) {
    if (typeof text !== 'string' || !text) return text
    try {
      var head = text.slice(0, 256)
      if (/^\s*#EXTM3U/.test(head)) return m3uPrune(text)
      if (/^\s*<\?xml/.test(head) || head.indexOf('<MPD') !== -1 || head.indexOf('<VAST') !== -1) {
        return xmlPrune(text)
      }
    } catch (e) {}
    return text
  }

  // 5+6a) Response.prototype.text()
  try {
    var originalText = Response.prototype.text
    Response.prototype.text = cloak(function () {
      return originalText.apply(this, arguments).then(function (txt) {
        return processResponseText(txt)
      })
    }, originalText)
  } catch (e) {}

  // XHR send — a single override handling BOTH (4) the outbound player-request
  // body spoof and (5+6) shadowing the per-instance responseText getter so a
  // completed HLS/XML response reads back pruned. Kept as one wrapper so the
  // cloak() mapping points straight at the true native send (no intermediate
  // wrapper leaks its JS source through toString). The native responseText
  // getter is reached via the prototype descriptor; if it throws (e.g. a
  // responseType mismatch) that error propagates naturally.
  try {
    var nativeXHRSend = XMLHttpRequest.prototype.send
    var xhrTextDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText')
    var nativeResponseTextGet =
      xhrTextDesc && typeof xhrTextDesc.get === 'function' ? xhrTextDesc.get : null

    XMLHttpRequest.prototype.send = cloak(function (body) {
      var sendBody = body
      var spoofedBody = false
      try {
        // (4) Outbound player-request context spoof.
        if (isPlayerUrl(this.__ssUrl) && typeof body === 'string') {
          var spoofed = spoofPlayerBody(body)
          if (spoofed !== body) {
            sendBody = spoofed
            spoofedBody = true
          }
        }
        // (5+6) Shadow responseText so completed HLS/XML bodies read pruned.
        if (nativeResponseTextGet && !this.__ssTextShadowed) {
          this.__ssTextShadowed = true
          var xhr = this
          Object.defineProperty(xhr, 'responseText', {
            configurable: true,
            get: function () {
              var raw = nativeResponseTextGet.call(xhr)
              if (xhr.readyState === 4) {
                try {
                  return processResponseText(raw)
                } catch (e) {}
              }
              return raw
            },
          })
        }
      } catch (e) {}
      if (spoofedBody) return nativeXHRSend.call(this, sendBody)
      return nativeXHRSend.apply(this, arguments)
    }, nativeXHRSend)
  } catch (e) {}
})()
