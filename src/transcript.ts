import type { TranscriptLine } from './types'

/**
 * Transcript fetch + parse. Runs in the content script so requests carry the
 * user's youtube.com cookies/consent state.
 *
 * Primary path: re-fetch the watch page HTML, extract ytInitialPlayerResponse,
 * pick a caption track, fetch its timedtext as json3. (Reading the live page's
 * inline scripts only works for the first real page load — after SPA
 * navigation the DOM still holds the previous video's player response, so the
 * re-fetch approach is used for both cases.)
 *
 * Fallback: timedtext XML when json3 returns nothing.
 */

export interface TranscriptResult {
  status: 'ok' | 'no-transcript' | 'live' | 'error'
  lines: TranscriptLine[]
  durationSeconds: number
}

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  kind?: string // 'asr' = auto-generated
}

/** Merge raw caption events into ~sentence-sized lines to keep prompts compact. */
const LINE_MAX_SECONDS = 10
const LINE_MAX_CHARS = 200

export async function fetchTranscript(
  videoId: string,
): Promise<TranscriptResult> {
  try {
    const playerResponse = await fetchPlayerResponse(videoId)
    if (!playerResponse) return { status: 'error', lines: [], durationSeconds: 0 }

    const details = playerResponse.videoDetails ?? {}
    const durationSeconds = Number(details.lengthSeconds ?? 0)
    if (details.isLive || details.isLiveContent) {
      return { status: 'live', lines: [], durationSeconds }
    }

    const tracks: CaptionTrack[] =
      playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
      []
    const track = pickTrack(tracks)
    if (!track) return { status: 'no-transcript', lines: [], durationSeconds }

    const lines = await fetchTimedText(track.baseUrl)
    if (lines.length === 0) {
      return { status: 'no-transcript', lines: [], durationSeconds }
    }
    return { status: 'ok', lines: mergeLines(lines), durationSeconds }
  } catch {
    return { status: 'error', lines: [], durationSeconds: 0 }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchPlayerResponse(videoId: string): Promise<any | null> {
  const response = await fetch(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    { credentials: 'same-origin' },
  )
  if (!response.ok) return null
  const html = await response.text()
  const marker = 'ytInitialPlayerResponse = '
  const start = html.indexOf(marker)
  if (start === -1) return null
  const json = extractBalancedJson(html, start + marker.length)
  if (!json) return null
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Extract a balanced {...} object starting at `from` (string-aware brace count). */
function extractBalancedJson(text: string, from: number): string | null {
  if (text[from] !== '{') return null
  let depth = 0
  let inString = false
  for (let i = from; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return text.slice(from, i + 1)
    }
  }
  return null
}

/** Prefer manual English captions, then auto-generated English, then anything. */
function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (tracks.length === 0) return null
  const english = tracks.filter((t) => t.languageCode?.startsWith('en'))
  return (
    english.find((t) => t.kind !== 'asr') ??
    english[0] ??
    tracks.find((t) => t.kind !== 'asr') ??
    tracks[0]
  )
}

async function fetchTimedText(baseUrl: string): Promise<TranscriptLine[]> {
  const json3 = await fetchJson3(baseUrl)
  if (json3.length > 0) return json3
  return fetchXml(baseUrl)
}

async function fetchJson3(baseUrl: string): Promise<TranscriptLine[]> {
  try {
    const response = await fetch(`${baseUrl}&fmt=json3`, {
      credentials: 'same-origin',
    })
    if (!response.ok) return []
    const data = await response.json()
    const lines: TranscriptLine[] = []
    for (const event of data.events ?? []) {
      if (!event.segs) continue
      const text = event.segs
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((seg: any) => seg.utf8 ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) continue
      const start = (event.tStartMs ?? 0) / 1000
      lines.push({
        start,
        end: start + (event.dDurationMs ?? 0) / 1000,
        text,
      })
    }
    return lines
  } catch {
    return []
  }
}

async function fetchXml(baseUrl: string): Promise<TranscriptLine[]> {
  try {
    const response = await fetch(baseUrl, { credentials: 'same-origin' })
    if (!response.ok) return []
    const xml = new DOMParser().parseFromString(
      await response.text(),
      'text/xml',
    )
    const lines: TranscriptLine[] = []
    xml.querySelectorAll('text').forEach((node) => {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!text) return
      const start = Number(node.getAttribute('start') ?? 0)
      lines.push({
        start,
        end: start + Number(node.getAttribute('dur') ?? 0),
        text,
      })
    })
    return lines
  } catch {
    return []
  }
}

function mergeLines(lines: TranscriptLine[]): TranscriptLine[] {
  const merged: TranscriptLine[] = []
  for (const line of lines) {
    const last = merged[merged.length - 1]
    if (
      last &&
      line.end - last.start <= LINE_MAX_SECONDS &&
      last.text.length + line.text.length <= LINE_MAX_CHARS
    ) {
      last.text = `${last.text} ${line.text}`
      last.end = Math.max(last.end, line.end)
    } else {
      merged.push({ ...line })
    }
  }
  return merged
}
