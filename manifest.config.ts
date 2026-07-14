import { defineManifest } from '@crxjs/vite-plugin'

// NOTE: "Ad Sensei" here is the ONLY place the public name appears in code.
// Everything else (package name, storage keys, namespaces) uses skip-sensei /
// skipSensei so a store-driven rebrand only touches this string + listing assets.
export default defineManifest({
  manifest_version: 3,
  name: 'Ad Sensei',
  version: '0.2.13',
  description:
    'Skip YouTube ads and AI-detected creator sponsor segments, and block ads & trackers across the web.',
  icons: {
    16: 'src/icons/icon-16.png',
    32: 'src/icons/icon-32.png',
    48: 'src/icons/icon-48.png',
    128: 'src/icons/icon-128.png',
  },
  permissions: [
    'storage',
    'activeTab',
    'declarativeNetRequest',
    // Lets the popup report how many ads were blocked on the current page.
    'declarativeNetRequestFeedback',
    // Runtime (un)registration of the MAIN-world aggressive-mode pruner.
    'scripting',
  ],
  optional_permissions: [
    // Clearing a site's cookies to lift an ad-blocker-detection flag (e.g.
    // YouTube's) is an opt-in recovery action, requested from the popup button
    // at the moment the user clicks it. The base install holds no cookie access.
    'cookies',
  ],
  host_permissions: [
    '*://*.youtube.com/*',
    // SponsorBlock crowd-sourced segment database (privacy-preserving hash
    // prefix lookup; on by default, so this stays a base permission).
    'https://sponsor.ajay.app/*',
  ],
  background: {
    service_worker: 'src/service-worker.ts',
    type: 'module',
  },
  content_scripts: [
    {
      // Match all of youtube.com, not just /watch*: YouTube is an SPA, so a
      // user landing on the homepage and clicking a video never triggers a new
      // page load. The script gates itself to watch pages at runtime.
      // document_start, not document_idle: on a cold watch-page load the
      // pre-roll starts playing seconds before document_idle fires, so the
      // engine must already be polling for the player by then.
      matches: ['*://*.youtube.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_start',
    },
    {
      // Aggressive-mode controller (isolated world): keeps the localStorage
      // flag in sync with the setting and relays pruning reports to the
      // activity log. The actual MAIN-world pruner (public/prune-main.js) is
      // registered/unregistered at runtime by the service worker via
      // chrome.scripting, so it only runs when the setting is on.
      matches: ['*://*.youtube.com/*'],
      js: ['src/content/prune-loader.ts'],
      run_at: 'document_start',
    },
    {
      // Cosmetic filtering. Declared statically for youtube.com ONLY — YouTube
      // display-ad hiding is a default-on feature and youtube.com access is a
      // required permission, so this needs no opt-in and adds no install-time
      // warning. Applying the SAME script to the rest of the web is the opt-in
      // "Block all ads" path: the service worker registers it at runtime on
      // *://*/* (see cosmetic-register.ts) once the user enables a web-cosmetic
      // feature and grants the optional all-sites permission. Keeping the broad
      // match OUT of the manifest is what keeps the base install YouTube-scoped.
      matches: ['*://*.youtube.com/*'],
      js: ['src/content/cosmetic.ts'],
      run_at: 'document_start',
      all_frames: true,
    },
  ],
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Ad Sensei',
    default_icon: {
      16: 'src/icons/icon-16.png',
      32: 'src/icons/icon-32.png',
    },
  },
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  // First-run welcome page (opened by the service worker on install). The
  // settings/activity/cache log is now a panel inside the options page.
  web_accessible_resources: [
    {
      // The cosmetic content script is registered at runtime on the broad web
      // (cosmetic-register.ts), so its built chunks — and the shared log/
      // storage chunks it imports — must stay web-accessible to any origin for
      // the loader's dynamic import() to resolve there. crxjs would otherwise
      // scope these to youtube.com (the script's only static match). Globs
      // survive the bundler's content-hashing.
      resources: [
        'assets/cosmetic*.js',
        'assets/log-*.js',
        'assets/storage-*.js',
      ],
      matches: ['<all_urls>'],
    },
  ],
  // General web ad blocking (the "Block all ads" engine). Rulesets are
  // block-only (EasyList-derived via AdGuard) and ship DISABLED — the toggle
  // enables them at runtime via updateEnabledRulesets, so we never hit the
  // static-rule limit at install. Files live in public/rulesets (see
  // scripts/build-rulesets.mjs).
  declarative_net_request: {
    rule_resources: [
      { id: 'ads_base', enabled: false, path: 'rulesets/ads_base.json' },
      { id: 'ads_mobile', enabled: false, path: 'rulesets/ads_mobile.json' },
      { id: 'trackers', enabled: false, path: 'rulesets/trackers.json' },
      { id: 'cookies', enabled: false, path: 'rulesets/cookies.json' },
      { id: 'social', enabled: false, path: 'rulesets/social.json' },
      { id: 'popups', enabled: false, path: 'rulesets/popups.json' },
      {
        id: 'url_tracking',
        enabled: false,
        path: 'rulesets/url_tracking.json',
      },
      // URLhaus (abuse.ch) malware domains — scripts/build-malware-ruleset.mjs
      { id: 'malware', enabled: false, path: 'rulesets/malware.json' },
    ],
  },
  // Requested at runtime so the base install keeps minimal host access:
  //  - the per-provider cloud LLM / local-gateway hosts, requested from the
  //    options page the moment the user selects that provider (default is
  //    Chrome's on-device AI, which needs none of these);
  //  - the broad `*://*/*` grant that powers web-wide cosmetic filtering,
  //    "Block all ads", URL-tracking-param stripping, and the anti-adblock
  //    scriptlet layer, requested when the user enables those features.
  optional_host_permissions: [
    'https://generativelanguage.googleapis.com/*',
    'https://api.anthropic.com/*',
    'https://api.openai.com/*',
    'https://api.groq.com/*',
    'https://openrouter.ai/*',
    'http://localhost/*',
    'http://127.0.0.1/*',
    '*://*/*',
  ],
})
