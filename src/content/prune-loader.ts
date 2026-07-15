/**
 * First-party pruner reporter (ISOLATED world, document_start on youtube.com).
 *
 * The actual pruning is public/prune-main.js, injected into the PAGE world by
 * the service worker via chrome.scripting when first-party ad blocking is on.
 * That script strips the ad schedule from the player response and posts the
 * break SCHEDULE (offsets into the content) here.
 *
 * This script counts a break only when playback actually REACHES its position,
 * not the whole video's total upfront — so watching 25 min of a movie counts
 * the 2 breaks you'd have hit, not all 5. (The page world can't reach
 * chrome.runtime; the isolated world can. The <video> element and its
 * currentTime live in the shared DOM, readable from here.)
 *
 * Countable unit = the ad BREAK (segment). The response doesn't say how many
 * individual ads a break would contain — that comes from the ad request the
 * pruner blocks — so one reached break = one counted ad.
 */

interface Break {
  ms: number // scheduled position in the content; 0 = pre-roll, -1 = post-roll
  counted: boolean
}

let activeVideoId: string | null = null
let breaks: Break[] = []
let poll: ReturnType<typeof setInterval> | null = null

function currentVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>('video.html5-main-video') ||
    document.querySelector<HTMLVideoElement>('.html5-video-player video') ||
    document.querySelector<HTMLVideoElement>('video')
  )
}

function reportBreak(): void {
  try {
    chrome.runtime
      .sendMessage({ type: 'skipSensei:adSkipped', method: 'pruned', count: 1 })
      .catch(() => {})
  } catch {
    // orphaned after an extension reload — nothing to report to
  }
}

function stopPoll(): void {
  if (poll !== null) {
    clearInterval(poll)
    poll = null
  }
}

/** Count any break whose scheduled position playback has now passed. Seeking
 * forward past an un-watched break still counts it — on real YouTube, seeking
 * past a mid-roll triggers the ad, so you were spared it either way. */
function tick(): void {
  // The active schedule belongs to activeVideoId. If the page has moved to a
  // different video — including an ad-free one, which posts no new schedule —
  // the breaks are stale; drop them so they're never counted against another
  // video's playback.
  const urlVid = new URLSearchParams(location.search).get('v')
  if (urlVid !== activeVideoId) {
    breaks = []
    stopPoll()
    return
  }
  const v = currentVideo()
  if (!v) return
  const t = v.currentTime
  if (!Number.isFinite(t) || t <= 0) return // not actually playing yet
  const dur = Number.isFinite(v.duration) ? v.duration : 0
  const tMs = t * 1000
  let remaining = 0
  for (const b of breaks) {
    if (b.counted) continue
    const reached =
      b.ms >= 0 ? tMs >= b.ms : dur > 0 && t >= dur - 2 // -1 = post-roll
    if (reached) {
      b.counted = true
      reportBreak()
    } else {
      remaining++
    }
  }
  if (remaining === 0) stopPoll() // whole schedule accounted for
}

function startPoll(): void {
  if (poll === null) poll = setInterval(tick, 1000)
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data as {
    source?: string
    type?: string
    videoId?: string
    offsets?: number[]
  } | null
  if (data?.source !== 'skip-sensei' || data?.type !== 'ad-schedule') return
  if (!data.videoId || !Array.isArray(data.offsets)) return
  // New video (SPA nav / autoplay) → replace the schedule; the pruner already
  // dedupes so the same videoId won't re-arrive.
  if (data.videoId !== activeVideoId) {
    activeVideoId = data.videoId
    breaks = data.offsets.map((ms) => ({ ms, counted: false }))
    if (breaks.length > 0) startPoll()
  }
})
