import type { SegmentType, SponsorSegment } from './types'

/**
 * SponsorBlock client (service-worker side). SponsorBlock is an open,
 * crowd-sourced database of user-submitted sponsor/intro/outro timestamps.
 * Using it gives instant, exact segments for any video someone has already
 * submitted — no transcript fetch, no LLM call — with the AI as the fallback
 * for videos with no submissions.
 *
 * Privacy: we never send the video id. We hash it (SHA-256), send only the
 * first 4 hex chars of the hash, receive every video whose hash shares that
 * prefix, and match our video locally. The server can't tell which video we
 * watched. https://wiki.sponsor.ajay.app/w/API_Docs#GET_/api/skipSegments/:sha256HashPrefix
 */

const API = 'https://sponsor.ajay.app/api/skipSegments'
const HASH_PREFIX_LEN = 4

/** SponsorBlock category id → our display type. */
const CATEGORY_TYPE: Record<string, SegmentType> = {
  sponsor: 'sponsor',
  selfpromo: 'self-promo',
  interaction: 'interaction',
  intro: 'intro',
  outro: 'outro',
  preview: 'preview',
  filler: 'filler',
  music_offtopic: 'music-offtopic',
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

interface SbSegment {
  segment: [number, number]
  category: string
  actionType: string
  votes?: number
}
interface SbVideo {
  videoID: string
  segments: SbSegment[]
}

/**
 * Fetch skippable SponsorBlock segments for `videoId`, limited to the given
 * category ids. Returns [] on any failure (404 = no submissions for this
 * prefix) so callers can cleanly fall through to the AI.
 */
export async function fetchSponsorBlockSegments(
  videoId: string,
  categories: string[],
): Promise<SponsorSegment[]> {
  if (!videoId || categories.length === 0) return []
  let list: SbVideo[]
  try {
    const prefix = (await sha256Hex(videoId)).slice(0, HASH_PREFIX_LEN)
    const params = new URLSearchParams({
      categories: JSON.stringify(categories),
      actionTypes: JSON.stringify(['skip']),
    })
    const res = await fetch(`${API}/${prefix}?${params}`, {
      credentials: 'omit',
    })
    if (!res.ok) return []
    list = await res.json()
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []

  const match = list.find((v) => v.videoID === videoId)
  if (!match || !Array.isArray(match.segments)) return []

  const out: SponsorSegment[] = []
  for (const seg of match.segments) {
    if (seg.actionType !== 'skip') continue
    const [start, end] = seg.segment ?? []
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start)
      continue
    if ((seg.votes ?? 0) < 0) continue // community-downvoted (likely wrong)
    const type = CATEGORY_TYPE[seg.category]
    if (!type) continue
    out.push({ start, end, type, confidence: 1, source: 'sponsorblock' })
  }
  return out.sort((a, b) => a.start - b.start)
}
