import { defineManifest } from '@crxjs/vite-plugin'

// NOTE: "Ad Sensei" here is the ONLY place the public name appears in code.
// Everything else (package name, storage keys, namespaces) uses skip-sensei /
// skipSensei so a store-driven rebrand only touches this string + listing assets.
export default defineManifest({
  manifest_version: 3,
  name: 'Ad Sensei',
  version: '0.1.0',
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
  ],
  host_permissions: [
    '*://*.youtube.com/*',
    // Cloud LLM providers for sponsor detection (only contacted when the user
    // configures an API key; default is Chrome's on-device AI).
    'https://generativelanguage.googleapis.com/*',
    'https://api.anthropic.com/*',
    'https://api.openai.com/*',
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
      matches: ['*://*.youtube.com/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
    {
      // Cosmetic filtering for "Block all ads": hide ad containers on every
      // site. Gates itself on the blockAllAds setting + allowlist at runtime.
      matches: ['<all_urls>'],
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
  // First-run welcome page (opened by the service worker on install).
  web_accessible_resources: [
    {
      resources: ['src/onboarding/index.html'],
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
    ],
  },
})
