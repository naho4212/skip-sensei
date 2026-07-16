import { writeFileSync } from 'node:fs'

const OUT = process.argv[2]

const HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700;900&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --purple:#7c3aed; --purple-2:#a78bfa; --purple-3:#6d28d9;
  --ink:#f7f5fc; --dim:#b3adc6; --faint:#7d7796;
  --card:rgba(255,255,255,.045); --line:rgba(255,255,255,.10);
  --sans:'Roboto',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif;
  --mono:'Roboto Mono',ui-monospace,monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1280px;height:800px;overflow:hidden}
body{
  font-family:var(--sans); color:var(--ink);
  background:
    radial-gradient(1100px 620px at 78% -8%, rgba(124,58,237,.42), transparent 60%),
    radial-gradient(900px 700px at 8% 108%, rgba(109,40,217,.30), transparent 62%),
    linear-gradient(160deg,#100e17 0%,#0a0810 60%,#08060d 100%);
  position:relative;
}
/* subtle dot grid */
body::before{
  content:""; position:absolute; inset:0;
  background-image:radial-gradient(rgba(255,255,255,.05) 1px, transparent 1px);
  background-size:34px 34px; mask:radial-gradient(1000px 600px at 60% 40%,#000,transparent 85%);
  pointer-events:none;
}
.wrap{position:relative; width:100%; height:100%; padding:70px 84px; display:flex; flex-direction:column}
.eyebrow{font-family:var(--mono); font-size:16px; letter-spacing:.32em; text-transform:uppercase; color:var(--purple-2); font-weight:500}
h1{font-weight:900; letter-spacing:-.022em; line-height:1.02}
h2{font-weight:900; letter-spacing:-.02em; line-height:1.04}
.sub{color:var(--dim); font-weight:400; line-height:1.5}
.grad{background:linear-gradient(92deg,var(--purple-2),#c4b5fd); -webkit-background-clip:text; background-clip:text; color:transparent}
/* brand lockup */
.brand{display:flex; align-items:center; gap:14px}
.brand .mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(150deg,var(--purple),var(--purple-3));
  display:grid;place-items:center;box-shadow:0 8px 26px rgba(124,58,237,.5), inset 0 1px 0 rgba(255,255,255,.25)}
.brand .name{font-weight:900;font-size:26px;letter-spacing:-.01em}
.brand .name b{color:var(--purple-2)}
.footer{margin-top:auto; display:flex; align-items:center; justify-content:space-between}
.pill{display:inline-flex;align-items:center;gap:10px;padding:11px 18px;border:1px solid var(--line);
  border-radius:999px;background:var(--card);font-family:var(--mono);font-size:15px;color:var(--ink)}
.pill .dot{width:9px;height:9px;border-radius:50%;background:var(--purple-2);box-shadow:0 0 12px var(--purple-2)}
.card{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:30px 28px}
.chk{display:flex;align-items:flex-start;gap:16px}
.chk .ic{flex:none;width:30px;height:30px;border-radius:9px;background:rgba(124,58,237,.16);border:1px solid rgba(167,139,250,.35);
  display:grid;place-items:center;margin-top:2px}
.glow{position:absolute;border-radius:50%;filter:blur(2px);pointer-events:none}
</style></head><body><div class="wrap">`

const FOOT = `</div></body></html>`

// --- reusable svg bits ---
const skipGlyph = (h = 34, c = '#c4b5fd') => `<svg width="${(h / 60) * 92}" height="${h}" viewBox="0 0 92 60" fill="none">
  <polygon points="0,0 34,30 0,60" fill="${c}"/><polygon points="38,0 72,30 38,60" fill="${c}"/>
  <rect x="80" y="0" width="12" height="60" rx="5" fill="${c}"/></svg>`
const enso = (s = 520, op = .16) => `<svg width="${s}" height="${s}" viewBox="0 0 100 100" style="opacity:${op}">
  <circle cx="50" cy="50" r="42" fill="none" stroke="url(#g)" stroke-width="5" stroke-linecap="round"
    pathLength="100" stroke-dasharray="86 100" transform="rotate(18 50 50)"/>
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs></svg>`
const check = (c = '#c4b5fd') => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="${c}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const brand = `<div class="brand"><div class="mark">${skipGlyph(20, '#fff')}</div><div class="name">Ad<b>Sensei</b></div></div>`

// icons for the three-layers slide
const icoGlobe = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>`
const icoShield = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="1.7"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4" stroke-width="1.9"/></svg>`
const icoPlay = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3V9z" fill="#c4b5fd" stroke="none"/></svg>`
const aiSpark = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9L12 3z" fill="#c4b5fd"/><path d="M19 3.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" fill="#a78bfa"/></svg>`
const aiHeal = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2 5.3"/><path d="M20 4v5h-5"/></svg>`
const aiScan = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="#c4b5fd" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`
const aiShield = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>`
const aiLock = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`

const slides = []

// ============ 1 — HERO ============
slides.push(`
<div class="glow" style="width:640px;height:640px;left:320px;top:70px;background:radial-gradient(circle,rgba(124,58,237,.5),transparent 60%)"></div>
<div style="position:absolute;right:-60px;top:120px">${enso(560, .14)}</div>
${brand}
<div style="margin:auto 0; max-width:920px">
  <div class="eyebrow" style="margin-bottom:22px">AI-powered ad blocker · YouTube &amp; the web</div>
  <h1 style="font-size:96px">Skip the ad.<br><span class="grad">Every&nbsp;ad.</span></h1>
  <p class="sub" style="font-size:26px;margin-top:26px;max-width:800px">
    YouTube video ads, creator sponsor reads, and ads &amp; trackers across the web —
    skipped automatically, with AI to catch the ones filter lists can’t.</p>
</div>
<div class="footer">
  <div style="display:flex;gap:14px">
    <span class="pill"><span class="dot"></span>YouTube ads</span>
    <span class="pill" style="background:rgba(124,58,237,.24);border-color:rgba(167,139,250,.6);box-shadow:0 0 24px rgba(124,58,237,.35)">
      <span style="display:grid;place-items:center;width:16px;height:16px">
        <svg width="15" height="15" viewBox="0 0 24 24"><path d="M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9L12 3z" fill="#c4b5fd"/></svg></span>AI sponsor-skip</span>
    <span class="pill"><span class="dot"></span>Web-wide blocking</span>
  </div>
  <div style="display:flex;align-items:center;gap:14px;color:var(--faint);font-family:var(--mono);font-size:15px">
    On-device AI · Private · Free ${skipGlyph(26)}</div>
</div>`)

// ============ 2 — YOUTUBE: ADS + SPONSOR READS ============
slides.push(`
${brand}
<div class="eyebrow" style="margin-top:32px">On YouTube</div>
<h2 style="font-size:54px;margin-top:12px;max-width:980px">Video ads &amp; sponsor reads —<br><span class="grad">both skipped</span></h2>
<div style="display:flex;gap:46px;align-items:center;margin-top:32px">
  <!-- mock player -->
  <div style="position:relative;flex:none;width:490px;height:276px;border-radius:18px;
     background:linear-gradient(160deg,#1c1830,#120f1e);border:1px solid var(--line);overflow:hidden;
     box-shadow:0 30px 80px rgba(0,0,0,.5)">
    <div style="position:absolute;inset:0;display:grid;place-items:center;opacity:.5">
      <svg width="66" height="66" viewBox="0 0 24 24" fill="none" stroke="#6b6482" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4V8z" fill="#6b6482" stroke="none"/></svg></div>
    <!-- skipped toast -->
    <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
       display:flex;align-items:center;gap:14px;padding:16px 26px;border-radius:14px;
       background:rgba(124,58,237,.20);border:1px solid rgba(167,139,250,.55);backdrop-filter:blur(6px);
       box-shadow:0 16px 50px rgba(124,58,237,.4)">
      ${skipGlyph(26)}<span style="font-weight:900;font-size:23px">Ad skipped</span></div>
    <!-- progress bar with crossed ad ticks -->
    <div style="position:absolute;left:20px;right:20px;bottom:18px;height:6px;border-radius:3px;background:rgba(255,255,255,.14)">
      <div style="position:absolute;left:0;top:0;bottom:0;width:38%;border-radius:3px;background:linear-gradient(90deg,#a78bfa,#7c3aed)"></div>
      <div style="position:absolute;left:38%;top:-3px;width:12px;height:12px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.25)"></div>
      <div style="position:absolute;left:70%;top:-3px;width:12px;height:12px;border-radius:50%;background:#4b465e"></div>
    </div>
  </div>
  <!-- checklist -->
  <div style="display:flex;flex-direction:column;gap:19px">
    ${['Pre-roll &amp; mid-roll ads', 'Creator sponsor reads — AI finds them in the transcript', 'Post-roll, overlays &amp; anti-ad-blocker walls', 'Clicks “Skip” the instant it renders — no ad flash'].map(t => `
      <div class="chk"><span class="ic">${check()}</span>
        <div style="font-size:20px;font-weight:700;padding-top:3px;max-width:420px;line-height:1.3">${t}</div></div>`).join('')}
  </div>
</div>
<!-- sponsor timeline -->
<div style="margin-top:36px;max-width:1010px">
  <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:14px;color:var(--faint);margin-bottom:12px">
    <span>0:00</span><span style="color:var(--purple-2)">SPONSOR 2:14 – 3:47 · skipped by AI</span><span>10:20</span></div>
  <div style="position:relative;height:26px;border-radius:13px;background:rgba(255,255,255,.08);border:1px solid var(--line)">
    <div style="position:absolute;left:0;top:0;bottom:0;width:21%;border-radius:13px 0 0 13px;background:rgba(167,139,250,.28)"></div>
    <div style="position:absolute;left:21%;top:-1px;bottom:-1px;width:16%;border-radius:6px;
       background:repeating-linear-gradient(115deg,rgba(124,58,237,.9),rgba(124,58,237,.9) 10px,rgba(167,139,250,.9) 10px,rgba(167,139,250,.9) 20px);
       box-shadow:0 0 30px rgba(124,58,237,.6);display:grid;place-items:center">
       <span style="font-family:var(--mono);font-size:12px;font-weight:500;color:#fff">SPONSOR</span></div>
    <!-- skip arrow leaping past -->
    <div style="position:absolute;left:37%;top:50%;transform:translate(-6px,-50%)">${skipGlyph(22, '#fff')}</div>
    <div style="position:absolute;left:37%;top:0;bottom:0;width:63%;border-radius:0 13px 13px 0;background:rgba(255,255,255,.05)"></div>
  </div>
</div>`)

// ============ 3 — WEB-WIDE BLOCKING ============
slides.push(`
${brand}
<div class="eyebrow" style="margin-top:36px">Across the web</div>
<h2 style="font-size:58px;margin-top:12px">Block ads on <span class="grad">every site</span></h2>
<p class="sub" style="font-size:21px;margin-top:16px;max-width:880px">
  Filter-list blocking for ads and trackers on every site — with AI to catch the
  ads no list has learned yet, and to click “reject all” on cookie prompts for you.</p>
<div style="display:flex;gap:13px;margin-top:26px;flex-wrap:wrap">
  ${['Trackers', 'Cookie banners', 'Popups', 'Social widgets', 'URL tracking'].map(t => `
    <span class="pill"><span class="dot"></span>${t}</span>`).join('')}
</div>
<div style="display:flex;gap:22px;margin-top:30px">
  ${[
    [icoGlobe, 'Filters that stay fresh', 'The same engine as the big blockers — and the lists refresh themselves between releases, no update required.'],
    [icoShield, 'First-party ads too', 'Sponsored pins, promoted products, and feed ads — served by the site itself, invisible to filter lists. Hidden automatically.'],
    [aiScan, 'AI gap-filler', 'Catches the ads lists miss on a site, learns them once, and hides them on every return visit.'],
  ].map(([ic, t, d]) => `
    <div class="card" style="flex:1;display:flex;flex-direction:column;gap:15px;padding:30px 28px">
      <span style="width:54px;height:54px;border-radius:15px;background:rgba(124,58,237,.15);border:1px solid rgba(167,139,250,.32);display:grid;place-items:center">${ic}</span>
      <div style="font-size:24px;font-weight:900;letter-spacing:-.01em;line-height:1.12">${t}</div>
      <div style="color:var(--dim);font-size:16.5px;line-height:1.5">${d}</div></div>`).join('')}
</div>`)

// ============ 4 — AI + PRIVACY ============
slides.push(`
<div class="glow" style="width:560px;height:560px;right:-120px;top:-80px;background:radial-gradient(circle,rgba(124,58,237,.42),transparent 62%)"></div>
<div style="position:absolute;right:-40px;bottom:-60px">${enso(420, .1)}</div>
${brand}
<div class="eyebrow" style="margin-top:44px">Powered by AI · Private by design</div>
<h2 style="font-size:60px;margin-top:14px">Smart. Private. <span class="grad">Free.</span></h2>
<p class="sub" style="font-size:21px;margin-top:18px;max-width:900px">
  AI handles what filter lists can’t — free on-device by default, with no account,
  no subscription, and nothing you watch sent anywhere.</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:38px;max-width:1015px">
  ${[
    [aiSpark, 'Transcript-based sponsor detection', 'AI reads what’s actually said to find paid segments — precision-first, so it never cuts real content.'],
    [aiHeal, 'Self-healing selectors', 'When YouTube changes its layout and breaks skipping, the AI re-finds the button and caches the fix. No update needed.'],
    [aiLock, '100% client-side, $0', 'No backend, no account, no card. Chrome’s built-in AI by default — or bring your own free key, or run fully local with Ollama.'],
    [aiShield, 'No tracking, ever', 'We don’t build a profile, sell data, or inject affiliate links — and a one-switch local-only mode means zero external calls.'],
  ].map(([ic, t, d]) => `
    <div class="card" style="display:flex;gap:18px;align-items:flex-start;padding:26px 26px">
      <span style="flex:none;width:48px;height:48px;border-radius:13px;background:rgba(124,58,237,.16);border:1px solid rgba(167,139,250,.34);display:grid;place-items:center">${ic}</span>
      <div><div style="font-size:20px;font-weight:800;margin-bottom:6px;letter-spacing:-.01em">${t}</div>
        <div style="color:var(--dim);font-size:16px;line-height:1.46">${d}</div></div></div>`).join('')}
</div>
<div class="footer" style="margin-top:28px">
  <span class="pill"><span class="dot"></span>Runs on Chrome’s built-in on-device model — nothing you watch is sent anywhere</span>
  ${skipGlyph(24)}
</div>`)

// ============ 5 — THE POPUP (real UI) ============
// A faithful still of the actual popup's "This site" view — same structure
// and dark-theme values as entrypoints/popup (matches the landing-page mock).
slides.push(`
<style>
  .pm{width:344px;border-radius:18px;overflow:hidden;text-align:left;background:#111113;
    border:1px solid rgba(255,255,255,.14);box-shadow:0 40px 100px rgba(0,0,0,.6),0 0 60px rgba(124,58,237,.25),0 0 0 1px rgba(124,58,237,.15);
    font-size:14px;line-height:1.4;font-weight:400;letter-spacing:normal}
  .pm,.pm *{font-family:var(--sans)}
  .pm-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px 10px}
  .pm-brandrow{display:flex;align-items:center;gap:11px}
  .pm-glyph{width:22px;height:16px;fill:#7c3aed;flex:none}
  .pm-brand{display:flex;flex-direction:column;line-height:1.25}
  .pm-wm{font-weight:900;font-size:14px;letter-spacing:-.01em;color:#f1f1f3}
  .pm-wm span{color:#8b5cf6}
  .pm-status{font-size:11px;color:#6a6b76}
  .pm-actions{display:flex;align-items:center;gap:12px;color:#6a6b76}
  .pm-tgl{width:34px;height:20px;border-radius:999px;background:#7c3aed;position:relative;flex:none}
  .pm-tgl::after{content:"";position:absolute;top:2px;right:2px;width:16px;height:16px;border-radius:50%;background:#fff}
  .pm-seg{display:flex;gap:2px;margin:0 12px 8px;padding:3px;background:#191a1d;border:1px solid rgba(255,255,255,.09);border-radius:11px}
  .pm-seg span{flex:1;text-align:center;padding:6px;border-radius:8px;font-size:12.5px;font-weight:500;color:#6a6b76}
  .pm-seg .on{background:rgba(124,58,237,.22);color:#f1f1f3}
  .pm-pad{padding:4px 12px 14px}
  .pm-sitehero{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;
    border:1px solid rgba(255,255,255,.09);border-radius:14px;background:#191a1d}
  .pm-siteinfo{display:flex;flex-direction:column;gap:3px}
  .pm-sitestatus{font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#8b5cf6;display:flex;align-items:center;gap:6px}
  .pm-sitestatus::before{content:"";width:7px;height:7px;border-radius:50%;background:#8b5cf6;box-shadow:0 0 8px rgba(139,92,246,.45)}
  .pm-host{font-size:17px;font-weight:600;letter-spacing:-.01em;color:#f1f1f3}
  .pm-pageblocked{font-size:11.5px;color:#9a9ba6}
  .pm-power{display:flex;align-items:center;justify-content:center;flex:none;width:46px;height:46px;border-radius:50%;
    border:2px solid #8b5cf6;color:#8b5cf6;background:rgba(124,58,237,.1);box-shadow:0 0 14px rgba(139,92,246,.45)}
  .pm-power svg{width:21px;height:21px}
  .pm-detail{display:flex;align-items:center;gap:8px;margin-top:8px;padding:12px 14px;border:1px solid rgba(255,255,255,.09);
    border-radius:14px;background:#191a1d;font-size:12.5px;color:#f1f1f3}
  .pm-chev,.pm-re{color:#6a6b76;font-size:11px}
  .pm-re{margin-left:auto;font-size:13px}
  .pm-eyebrow{margin:14px 2px 6px;font-size:9.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:#6a6b76}
  .pm-statrow{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
  .pm-stat{display:flex;flex-direction:column;align-items:center;gap:2px;padding:9px 3px 7px;
    border:1px solid rgba(255,255,255,.09);border-radius:12px;background:#191a1d;text-align:center}
  .pm-stat b{font-size:15.5px;font-weight:700;color:#f1f1f3;letter-spacing:-.02em}
  .pm-stat span{font-size:10px;color:#9a9ba6}
  .pm-stat i{font-style:normal;font-size:9.5px;color:#6a6b76}
  .pm-foot{display:flex;justify-content:center;gap:8px;padding:10px;border-top:1px solid rgba(255,255,255,.09);font-size:12px;color:#6a6b76}
</style>
<div class="glow" style="width:560px;height:560px;right:40px;top:120px;background:radial-gradient(circle,rgba(124,58,237,.4),transparent 62%)"></div>
${brand}
<div style="display:flex;align-items:center;gap:80px;margin-top:34px;flex:1">
  <div style="max-width:480px">
    <div class="eyebrow">The popup</div>
    <h2 style="font-size:58px;margin-top:14px">The whole app,<br><span class="grad">one click away</span></h2>
    <p class="sub" style="font-size:21px;margin-top:20px">
      A master switch, a pause button per site, and live counts of everything
      blocked — nothing to configure unless you want to.</p>
    <div style="display:flex;flex-direction:column;gap:18px;margin-top:36px">
      ${['Pause blocking on any site with one tap', 'AI sponsor-skip status for the video you’re watching', 'Live counts — this page, today, all-time'].map(t => `
        <div class="chk"><span class="ic">${check()}</span>
          <div style="font-size:20px;font-weight:700;padding-top:3px">${t}</div></div>`).join('')}
    </div>
  </div>
  <div style="transform:scale(1.34);transform-origin:center">
    <div class="pm">
      <div class="pm-head">
        <div class="pm-brandrow">
          <svg class="pm-glyph" viewBox="0 0 24 17"><path d="M0 1.5l6 7-6 7v-14zm7.5 0l6 7-6 7v-14zm8.5 0h2.4v14H16v-14z"/></svg>
          <div class="pm-brand"><span class="pm-wm"><span>AD</span> SENSEI</span><span class="pm-status">Protection active</span></div>
        </div>
        <div class="pm-actions"><span>↻</span><span class="pm-tgl"></span></div>
      </div>
      <div class="pm-seg"><span class="on">This site</span><span>Controls</span></div>
      <div class="pm-pad">
        <div class="pm-sitehero">
          <div class="pm-siteinfo">
            <span class="pm-sitestatus">Blocking active</span>
            <span class="pm-host">youtube.com</span>
            <span class="pm-pageblocked">23 blocked on this page</span>
          </div>
          <span class="pm-power"><svg viewBox="0 0 24 24"><path d="M12 3v9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M7.4 6.4a7 7 0 1 0 9.2 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></span>
        </div>
        <div class="pm-detail"><span class="pm-chev">▸</span><span>2 sponsor segments skipped</span><span class="pm-re">↻</span></div>
        <div class="pm-eyebrow">Blocked everywhere</div>
        <div class="pm-statrow">
          <div class="pm-stat"><b>1,284</b><span>YouTube</span><i>7 today</i></div>
          <div class="pm-stat"><b>18,930</b><span>Web ads</span><i>166 today</i></div>
          <div class="pm-stat"><b>4,102</b><span>Trackers</span><i>38 today</i></div>
          <div class="pm-stat"><b>912</b><span>Cookies</span><i>12 today</i></div>
        </div>
      </div>
      <div class="pm-foot">↗ Share <span>·</span> ☕ Buy me a coffee</div>
    </div>
  </div>
</div>`)

slides.forEach((body, i) => {
  writeFileSync(`${OUT}/slide-${i + 1}.html`, HEAD + body + FOOT)
})
console.log(`wrote ${slides.length} slides to ${OUT}`)
