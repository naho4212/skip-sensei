import { defineConfig } from 'wxt'

// NOTE: "Ad Sensei" here is the ONLY place the public name appears in code.
// Everything else (package name, storage keys, namespaces) uses skip-sensei /
// skipSensei so a store-driven rebrand only touches this string + listing assets.
//
// Entrypoint-owned manifest keys (background, content_scripts, action popup,
// options_ui page) live in entrypoints/*; everything else is declared here and
// merged into the generated manifest. Version comes from package.json.
export default defineConfig({
  // No auto-imports: this codebase uses explicit imports throughout.
  imports: false,
  // Don't auto-launch a throwaway browser in dev — the workflow here is a
  // persistent load-unpacked install (point it at .output/chrome-mv3-dev
  // while developing), which the dev server hot-reloads in place, same as
  // the old vite/crxjs flow.
  webExt: {
    disabled: true,
  },
  manifest: {
    // Store-search keywords ride the name (the heaviest-weighted field);
    // "for YouTube™" at the END is the nominative-fair-use pattern Featured
    // competitors use (SponsorBlock for YouTube). Decided pre-first-publish —
    // renaming after publish is a malware-correlated signal (see
    // docs/cws-submission.md "Listing identity discipline").
    name: 'Ad Sensei — AI Ad Blocker, YouTube™ Ad & Sponsor Skip, Music Streaming Ads',
    // Leads with the web-wide single purpose; YouTube is that purpose applied
    // to one site (see docs/cws-submission.md — trademark-in-listing risk).
    description:
      'Block ads and trackers on every site, skip YouTube video ads and sponsor reads, silence music-player ads. Private, on-device AI.',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    permissions: [
      'storage',
      'activeTab',
      'declarativeNetRequest',
      // Lets the popup report how many ads were blocked on the current page.
      'declarativeNetRequestFeedback',
      // Runtime (un)registration of the MAIN-world aggressive-mode pruner.
      'scripting',
      // Periodic background check for filter-data updates (see filter-updates.ts).
      // Warning-free permission — adding it never disables the extension for
      // existing users on update.
      'alarms',
    ],
    optional_permissions: [
      // Clearing a site's cookies to lift an ad-blocker-detection flag (e.g.
      // YouTube's) is an opt-in recovery action, requested from the popup button
      // at the moment the user clicks it. The base install holds no cookie access.
      'cookies',
    ],
    // SponsorBlock (sponsor.ajay.app) is deliberately NOT a host permission:
    // its API answers every request with Access-Control-Allow-Origin: * and
    // our lookup is a plain credential-less GET, so the fetch works under
    // ordinary CORS. Listing it only added "…and sponsor.ajay.app" to the
    // install prompt, which reads as an unrelated site to anyone who doesn't
    // know the project.
    // All sites, at install — the store listing is "ad blocker for all ads",
    // and Balanced (web-wide blocking) is the default, so the base install
    // needs the same access every general ad blocker declares. This also
    // means a user who closes the welcome page without picking a level still
    // gets web-wide blocking (previously the grant was optional and only
    // requested on a level-card click, so skipped onboarding = YouTube-only).
    host_permissions: ['*://*/*'],
    action: {
      default_title: 'Ad Sensei',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
      },
    },
    // options_ui.open_in_tab lives in entrypoints/options/index.html as a
    // <meta name="manifest.open_in_tab"> tag — a manifest override here is
    // silently clobbered by the entrypoint-generated options_ui object.
    //
    // No web_accessible_resources: WXT bundles each content script as a
    // self-contained IIFE, so the runtime-registered cosmetic script has no
    // shared chunks to dynamic-import (the crxjs-era WAR globs are obsolete).
    //
    // General web ad blocking (the "Block all ads" engine). Rulesets are
    // block-only (EasyList-derived via AdGuard) and ship DISABLED — the toggle
    // enables them at runtime via updateEnabledRulesets, so we never hit the
    // static-rule limit at install. Files live in public/rulesets (see
    // scripts/build-rulesets.mjs).
    declarative_net_request: {
      rule_resources: [
        // Always-on YouTube exemption (1 allowAllRequests rule): network-
        // blocking YouTube trips its enforcement walls, so the exemption must
        // exist from INSTALL time — a static enabled ruleset has no runtime
        // ordering, no dynamic-rule race, and no failure mode. The disabled-
        // at-install rationale below doesn't apply to a single rule.
        { id: 'yt_exempt', enabled: true, path: 'rulesets/yt_exempt.json' },
        { id: 'ads_base', enabled: false, path: 'rulesets/ads_base.json' },
        { id: 'ads_mobile', enabled: false, path: 'rulesets/ads_mobile.json' },
        // Spotify web-player ad endpoints (AdGuard files them under Tracking
        // Protection; we ship them with the ad lists) — build-rulesets.mjs.
        { id: 'streaming', enabled: false, path: 'rulesets/streaming.json' },
        { id: 'trackers', enabled: false, path: 'rulesets/trackers.json' },
        // Second half of Tracking Protection (see build-rulesets.mjs shards).
        { id: 'trackers_2', enabled: false, path: 'rulesets/trackers_2.json' },
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
  },
})
