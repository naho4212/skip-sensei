import type { TranscriptLine } from './types'

/**
 * Transcript fetch + parse. Runs in the content script so requests carry the
 * user's youtube.com cookies/consent state.
 *
 * Primary path: the InnerTube `get_panel` endpoint with
 * panelId "PAmodern_transcript_view" — the same call YouTube's own transcript
 * panel makes. Its `params` is a small protobuf wrapping the videoId, so it
 * needs no signed URLs. (The classic timedtext API now returns empty 200s
 * unless the request carries the player's proof-of-origin token, so it can no
 * longer be the primary — verified live 2026-07.)
 *
 * Fallback: watch-page player response → timedtext (json3, then XML), kept in
 * case get_panel changes shape.
 */

export interface TranscriptResult {
  status: 'ok' | 'no-transcript' | 'error'
  lines: TranscriptLine[]
}

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  kind?: string // 'asr' = auto-generated
}

/** Merge raw caption events into ~sentence-sized lines to keep prompts compact. */
const LINE_MAX_SECONDS = 10
const LINE_MAX_CHARS = 200

/** Used when the live page doesn't expose INNERTUBE_CLIENT_VERSION; YouTube accepts slightly stale versions. */
const FALLBACK_CLIENT_VERSION = '2.20260706.00.00'

export async function fetchTranscript(
  videoId: string,
): Promise<TranscriptResult> {
  try {
    const panelLines = await fetchViaPanel(videoId)
    if (panelLines.length > 0) {
      return { status: 'ok', lines: mergeLines(panelLines) }
    }
    const timedTextLines = await fetchViaTimedText(videoId)
    if (timedTextLines.length > 0) {
      return { status: 'ok', lines: mergeLines(timedTextLines) }
    }
    return { status: 'no-transcript', lines: [] }
  } catch {
    return { status: 'error', lines: [] }
  }
}

// ---------------------------------------------------------------------------
// Primary: InnerTube get_panel
// ---------------------------------------------------------------------------

async function fetchViaPanel(videoId: string): Promise<TranscriptLine[]> {
  const response = await fetch(
    'https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false',
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB',
            clientVersion: getClientVersion(),
            hl: 'en',
          },
        },
        panelId: 'PAmodern_transcript_view',
        params: buildPanelParams(videoId),
      }),
    },
  )
  if (!response.ok) return []
  const data = await response.json()

  // Segments appear as transcriptSegmentViewModel ({timestamp: "34:35",
  // simpleText}) in the current UI, or transcriptSegmentRenderer ({startMs,
  // snippet.runs}) in the older shape. Walk the whole response for both.
  const raw: { start: number; text: string }[] = []
  collectSegments(data, raw)
  raw.sort((a, b) => a.start - b.start)

  return raw.map((seg, i) => ({
    start: seg.start,
    // The panel provides no end times; the next segment's start is the best proxy.
    end: i + 1 < raw.length ? raw[i + 1].start : seg.start + 8,
    text: seg.text,
  }))
}

/**
 * get_panel params: base64 protobuf
 *   field 165 { field 1: videoId, field 3: 1 }
 * Verified byte-for-byte against YouTube's own transcript-panel request.
 */
function buildPanelParams(videoId: string): string {
  const idBytes = new TextEncoder().encode(videoId)
  const inner = [0x0a, idBytes.length, ...idBytes, 0x18, 0x01]
  const bytes = [0xaa, 0x09, inner.length, ...inner]
  return btoa(String.fromCharCode(...bytes))
}

function getClientVersion(): string {
  for (const script of document.querySelectorAll('script')) {
    const match = script.textContent?.match(
      /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/,
    )
    if (match) return match[1]
  }
  return FALLBACK_CLIENT_VERSION
}

function collectSegments(
  node: unknown,
  out: { start: number; text: string }[],
) {
  if (!node || typeof node !== 'object') return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = node as any

  const viewModel = obj.transcriptSegmentViewModel
  if (viewModel?.timestamp && typeof viewModel.simpleText === 'string') {
    const text = viewModel.simpleText.replace(/\s+/g, ' ').trim()
    if (text) out.push({ start: parseTimestamp(viewModel.timestamp), text })
  }

  const renderer = obj.transcriptSegmentRenderer
  if (renderer?.startMs !== undefined) {
    const text = (renderer.snippet?.runs ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((run: any) => run.text ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) out.push({ start: Number(renderer.startMs) / 1000, text })
  }

  for (const value of Object.values(obj)) collectSegments(value, out)
}

/** "34:35" or "1:02:11" → seconds. */
function parseTimestamp(timestamp: string): number {
  return timestamp
    .trim()
    .split(':')
    .reduce((total, part) => total * 60 + Number(part), 0)
}

// ---------------------------------------------------------------------------
// Fallback: watch-page player response → timedtext
// ---------------------------------------------------------------------------

async function fetchViaTimedText(videoId: string): Promise<TranscriptLine[]> {
  const playerResponse = await fetchPlayerResponse(videoId)
  const tracks: CaptionTrack[] =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
    []
  const track = pickTrack(tracks)
  if (!track) return []
  const json3 = await fetchJson3(track.baseUrl)
  if (json3.length > 0) return json3
  return fetchXml(track.baseUrl)
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
