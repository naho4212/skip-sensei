/**
 * Anti-adblock / ad-defusing scriptlet engine — runs in the PAGE (MAIN) world
 * at document_start, injected via chrome.scripting on sites where the
 * extension holds host permission.
 *
 * It's a small, safe subset of uBlock Origin's scriptlet library. Sites that
 * detect ad-blocking (or re-insert ads after we hide them) read a global flag,
 * booby-trap a property, poll on a timer, or measure whether an ad slot got
 * hidden. Each of those has a matching countermeasure here.
 *
 * SAFETY MODEL: scriptlets are NEVER run globally by accident. Nothing fires
 * unless the current hostname (or one of its parent domains, or the special
 * '*' bucket) has an entry in SCRIPTLETS_CONFIG below. Keep the '*' bucket
 * minimal and provably non-breaking; prefer per-hostname entries.
 *
 * ---------------------------------------------------------------------------
 * CONFIG FORMAT — how to extend this file later:
 *
 *   SCRIPTLETS_CONFIG = {
 *     '<hostname>': [
 *       [ '<scriptlet-name>', '<arg1>', '<arg2>', ... ],
 *       ...
 *     ],
 *     '*': [ ...safest-generic invocations that apply to every site... ]
 *   }
 *
 * - The key is a bare hostname ('example.com') OR '*' for global.
 * - A page at 'a.b.example.com' matches keys 'a.b.example.com',
 *   'b.example.com', and 'example.com' (parent-domain suffixes), plus '*'.
 * - Each invocation is an array: the first element is the scriptlet name, the
 *   rest are string args. Semantics mirror uBO's scriptlets.
 * - Available scriptlets: 'set-constant', 'abort-on-property-read',
 *   'abort-on-property-write', 'prevent-setTimeout',
 *   'prevent-addEventListener', 'spoof-css'.
 *
 * To add coverage for a site: add a key with the invocations it needs. When in
 * doubt, scope to the specific hostname rather than '*'.
 *
 * This file is intentionally plain ES5-ish JS with no imports: it's copied
 * verbatim from public/ and injected as-is into the page.
 */
;(function () {
  'use strict'
  // 1) Guard — never install twice into the same page world.
  if (window.__skipSenseiScriptlets) return
  window.__skipSenseiScriptlets = true

  // -------------------------------------------------------------------------
  // CONFIG. See the format comment at the top of the file.
  //
  // Entries are drawn from widely-documented, generic anti-adblock flags. The
  // '*' bucket holds only the safest, universally-inert flags (setting a
  // "you may run ads" boolean true never breaks a page that doesn't read it).
  // Anything with a chance of side effects is scoped to a hostname instead.
  // -------------------------------------------------------------------------
  var SCRIPTLETS_CONFIG = {
    '*': [
      // Classic "is it safe to show ads?" flags. Harmless when absent.
      ['set-constant', 'canRunAds', 'true'],
      ['set-constant', 'window.canRunAds', 'true'],
      ['set-constant', 'canShowAds', 'true'],
      ['set-constant', 'isAdblockActive', 'false'],
      // Common adblock-detector library sentinels.
      ['set-constant', 'blockAdBlock', 'false'],
      ['set-constant', 'adblockDetector', 'noopFunc'],
    ],
    // Example real hostnames — illustrate per-site scoping. Extend as needed.
    'example.com': [
      ['abort-on-property-read', 'blockAdBlock'],
      ['abort-on-property-read', 'BlockAdBlock'],
    ],
    'example.org': [
      ['set-constant', 'adsbygoogle.loaded', 'true'],
      ['prevent-setTimeout', 'adblock'],
    ],
  }

  // -------------------------------------------------------------------------
  // 2) safeSelf — pristine native references captured at load time, before any
  // page script can override them. Everything below routes through these so a
  // later monkey-patch by page code can't break or observe us.
  // -------------------------------------------------------------------------
  var safe = {
    Object_defineProperty: Object.defineProperty.bind(Object),
    Object_getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor.bind(Object),
    Function_toString: Function.prototype.toString,
    JSON_parse: JSON.parse.bind(JSON),
    RegExp: window.RegExp,
    Math_random: Math.random.bind(Math),
    Math_floor: Math.floor.bind(Math),
    WeakMap: window.WeakMap,
    setTimeout: window.setTimeout,
    getComputedStyle: window.getComputedStyle,
  }

  // Random token used for abort errors — makes them hard to catch by message.
  function randomToken() {
    try {
      return (
        safe.Math_floor(safe.Math_random() * 982451653 + 982451653).toString(36)
      )
    } catch (e) {
      return 'abort'
    }
  }

  // -------------------------------------------------------------------------
  // 3) Native-function cloaking. Integrity checks like
  //   fn.toString().includes('[native code]')
  // are common in anti-adblock code. We patch Function.prototype.toString once
  // so any function we register reports its ORIGINAL's source. Replacement ->
  // original is tracked in a WeakMap. The patched toString cloaks itself too.
  // -------------------------------------------------------------------------
  var cloakMap
  var patchedToString
  try {
    cloakMap = new safe.WeakMap()
    var nativeToString = safe.Function_toString
    patchedToString = function toString() {
      try {
        if (cloakMap.has(this)) {
          return nativeToString.call(cloakMap.get(this))
        }
      } catch (e) {}
      return nativeToString.call(this)
    }
    // eslint-disable-next-line no-extend-native
    Function.prototype.toString = patchedToString
    // Cloak the patched toString as itself (report the native toString source).
    cloakMap.set(patchedToString, nativeToString)
  } catch (e) {}

  // Register replacementFn so its .toString() mirrors originalFn's, then return
  // replacementFn. Every scriptlet that installs a native replacement uses this.
  function cloak(replacementFn, originalFn) {
    try {
      if (cloakMap && typeof replacementFn === 'function') {
        cloakMap.set(replacementFn, originalFn || function () {})
      }
    } catch (e) {}
    return replacementFn
  }

  // A shared cloaked no-op (uBO's "noopFunc").
  var noopFunc = cloak(function () {}, function () {})

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  // Interpret a uBO-style set-constant value token.
  function parseConstant(raw) {
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (raw === 'null') return null
    if (raw === 'undefined') return undefined
    if (raw === 'noopFunc') return noopFunc
    if (raw === '' || raw === "''" || raw === '""') return ''
    if (raw === 'NaN') return NaN
    if (raw === 'Infinity') return Infinity
    if (raw === '-Infinity') return -Infinity
    // Numeric?
    if (/^-?\d+(\.\d+)?$/.test(raw)) {
      var n = Number(raw)
      if (!isNaN(n)) return n
    }
    // Fall back to the literal string.
    return raw
  }

  // Walk a dotted chain from a root object, creating intermediate plain objects
  // as needed. Returns { owner, prop } for the leaf, or null on failure.
  // Strips a leading 'window.' since the root IS window.
  function resolveChain(chain) {
    try {
      var path = String(chain)
      if (path.indexOf('window.') === 0) path = path.slice(7)
      var parts = path.split('.')
      var owner = window
      for (var i = 0; i < parts.length - 1; i++) {
        var key = parts[i]
        var next = owner[key]
        if (next === undefined || next === null) {
          next = {}
          try {
            owner[key] = next
          } catch (e) {
            return null
          }
        }
        if (typeof next !== 'object' && typeof next !== 'function') return null
        owner = next
      }
      return { owner: owner, prop: parts[parts.length - 1] }
    } catch (e) {
      return null
    }
  }

  // Convert a uBO pattern arg into a matcher. '/re/flags' -> RegExp; otherwise a
  // plain substring needle. Empty / undefined -> match-everything.
  function toMatcher(pattern) {
    if (pattern === undefined || pattern === '' || pattern === '*') {
      return function () {
        return true
      }
    }
    var str = String(pattern)
    if (str.length > 2 && str.charAt(0) === '/') {
      var last = str.lastIndexOf('/')
      if (last > 0) {
        try {
          var re = new safe.RegExp(str.slice(1, last), str.slice(last + 1))
          return function (s) {
            try {
              return re.test(s)
            } catch (e) {
              return false
            }
          }
        } catch (e) {
          /* fall through to substring */
        }
      }
    }
    return function (s) {
      try {
        return String(s).indexOf(str) !== -1
      } catch (e) {
        return false
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4) Scriptlet implementations. Each is wrapped in try/catch by the caller;
  // a throwing scriptlet must never break its neighbours.
  // -------------------------------------------------------------------------

  // set-constant(chain, value): pin a property to a constant that resists being
  // overwritten with a different value. The main anti-adblock lever.
  function setConstant(chain, valueArg) {
    var target = resolveChain(chain)
    if (!target) return
    var value = parseConstant(valueArg)
    var owner = target.owner
    var prop = target.prop
    var current = value
    try {
      safe.Object_defineProperty(owner, prop, {
        configurable: true,
        get: function () {
          return current
        },
        set: function (v) {
          // Allow the page to keep our value or objects; silently ignore
          // attempts to flip it to a different primitive (the detection reset).
          if (v === value) current = v
        },
      })
    } catch (e) {}
  }

  // abort-on-property-read(chain): reading the property throws a random-token
  // Error, aborting the detector script that touches it.
  function abortOnPropertyRead(chain) {
    var target = resolveChain(chain)
    if (!target) return
    var token = randomToken()
    try {
      safe.Object_defineProperty(target.owner, target.prop, {
        configurable: false,
        get: function () {
          throw new ReferenceError(token)
        },
        set: function () {},
      })
    } catch (e) {}
  }

  // abort-on-property-write(chain): writing the property throws.
  function abortOnPropertyWrite(chain) {
    var target = resolveChain(chain)
    if (!target) return
    var token = randomToken()
    try {
      safe.Object_defineProperty(target.owner, target.prop, {
        configurable: false,
        get: function () {
          return undefined
        },
        set: function () {
          throw new ReferenceError(token)
        },
      })
    } catch (e) {}
  }

  // prevent-setTimeout(pattern, delayMatch?): drop timers whose callback source
  // matches `pattern` (and, if given, whose delay equals delayMatch). Everything
  // else passes through untouched.
  function preventSetTimeout(pattern, delayMatch) {
    try {
      var matchCb = toMatcher(pattern)
      var wantDelay = delayMatch === undefined || delayMatch === '' ? null : Number(delayMatch)
      var original = window.setTimeout
      var wrapper = cloak(function (fn, delay) {
        try {
          var src = typeof fn === 'function' ? safe.Function_toString.call(fn) : String(fn)
          var delayOk = wantDelay === null || Number(delay) === wantDelay
          if (delayOk && matchCb(src)) {
            return 0 // dummy id; callback dropped
          }
        } catch (e) {}
        return original.apply(this, arguments)
      }, original)
      window.setTimeout = wrapper
    } catch (e) {}
  }

  // prevent-addEventListener(typePattern?, handlerPattern?): drop listeners
  // whose event type and/or handler source match. Undefined pattern = wildcard.
  function preventAddEventListener(typePattern, handlerPattern) {
    try {
      var matchType = toMatcher(typePattern)
      var matchHandler = toMatcher(handlerPattern)
      var proto = EventTarget.prototype
      var original = proto.addEventListener
      var wrapper = cloak(function (type, listener) {
        try {
          var handlerSrc =
            typeof listener === 'function'
              ? safe.Function_toString.call(listener)
              : String(listener)
          if (matchType(String(type)) && matchHandler(handlerSrc)) {
            return // listener dropped
          }
        } catch (e) {}
        return original.apply(this, arguments)
      }, original)
      proto.addEventListener = wrapper
    } catch (e) {}
  }

  // spoof-css(selector, prop?): make elements matching `selector` report as
  // visible to layout-inspection adblock checks. Conservative: only elements
  // matching the selector are spoofed; everything else is reported truthfully.
  function spoofCss(selector, prop) {
    if (!selector) return
    try {
      var matches = function (el) {
        try {
          return el && el.nodeType === 1 && el.matches && el.matches(selector)
        } catch (e) {
          return false
        }
      }

      // getComputedStyle: report display/visibility as visible for matches.
      var origGCS = window.getComputedStyle
      var gcsWrapper = cloak(function (el, pseudo) {
        var style = origGCS.apply(this, arguments)
        if (!matches(el)) return style
        try {
          return new Proxy(style, {
            get: function (target, key) {
              if (key === 'display') return 'block'
              if (key === 'visibility') return 'visible'
              if (key === 'opacity') return '1'
              if (key === 'getPropertyValue') {
                return function (name) {
                  if (name === 'display') return 'block'
                  if (name === 'visibility') return 'visible'
                  if (name === 'opacity') return '1'
                  return target.getPropertyValue(name)
                }
              }
              var v = target[key]
              return typeof v === 'function' ? v.bind(target) : v
            },
          })
        } catch (e) {
          return style
        }
      }, origGCS)
      window.getComputedStyle = gcsWrapper

      // getBoundingClientRect: report non-zero size for matches.
      var origRect = Element.prototype.getBoundingClientRect
      var rectWrapper = cloak(function () {
        var rect = origRect.apply(this, arguments)
        if (!matches(this)) return rect
        try {
          if (rect.width && rect.height) return rect
          return {
            x: rect.x || 0,
            y: rect.y || 0,
            top: rect.top || 0,
            left: rect.left || 0,
            right: (rect.left || 0) + 100,
            bottom: (rect.top || 0) + 100,
            width: rect.width || 100,
            height: rect.height || 100,
            toJSON: function () {
              return this
            },
          }
        } catch (e) {
          return rect
        }
      }, origRect)
      Element.prototype.getBoundingClientRect = rectWrapper
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 5) Dispatcher — map scriptlet names to implementations and run invocations
  // for every config key matching the current hostname.
  // -------------------------------------------------------------------------
  var REGISTRY = {
    'set-constant': setConstant,
    'abort-on-property-read': abortOnPropertyRead,
    'abort-on-property-write': abortOnPropertyWrite,
    'prevent-setTimeout': preventSetTimeout,
    'prevent-addEventListener': preventAddEventListener,
    'spoof-css': spoofCss,
  }

  // hostname -> ['a.b.c', 'b.c', 'c'] parent-domain suffixes.
  function domainSuffixes(hostname) {
    var out = []
    try {
      var parts = String(hostname).split('.')
      while (parts.length > 1) {
        out.push(parts.join('.'))
        parts.shift()
      }
      if (parts.length === 1 && parts[0]) out.push(parts[0])
    } catch (e) {}
    return out
  }

  function runInvocation(inv) {
    try {
      if (!inv || !inv.length) return
      var name = inv[0]
      var fn = REGISTRY[name]
      if (typeof fn !== 'function') return
      fn.apply(null, inv.slice(1))
    } catch (e) {
      // A throwing scriptlet must not break the others.
    }
  }

  try {
    var host = ''
    try {
      host = window.location.hostname || ''
    } catch (e) {}

    var keys = domainSuffixes(host)
    var seen = {}
    var i

    // '*' bucket first, then most-specific host key down to the TLD-adjacent.
    var buckets = ['*'].concat(keys)
    for (i = 0; i < buckets.length; i++) {
      var key = buckets[i]
      if (seen[key]) continue
      seen[key] = true
      var list = SCRIPTLETS_CONFIG[key]
      if (!list || !list.length) continue
      for (var j = 0; j < list.length; j++) {
        runInvocation(list[j])
      }
    }
  } catch (e) {
    // Whole-dispatch failsafe: never throw into the page.
  }
})()
