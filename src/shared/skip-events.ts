import { SKIP_TYPES, type SkipSegment, type SkipType } from './types';

/**
 * Crunchyroll publishes per-episode skip timing as static JSON. This same data
 * powers their native "Skip Intro" button.
 *
 *   https://static.crunchyroll.com/skip-events/production/{episodeId}.json
 *
 * Shape (fields beyond start/end vary and are ignored):
 *   {
 *     "intro":   { "start": 0,   "end": 89,  "type": "intro", ... },
 *     "recap":   { "start": ... },
 *     "credits": { "start": ... },
 *     "preview": { "start": ... }
 *   }
 *
 * Any key may be absent. We parse defensively: bad/missing data yields an empty
 * segment list, which makes the caller fall back to clicking the native button.
 */
export function skipEventsUrl(episodeId: string): string {
  return `https://static.crunchyroll.com/skip-events/production/${encodeURIComponent(
    episodeId,
  )}.json`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Convert the raw JSON object into normalized, sane SkipSegment[]. */
export function parseSkipEvents(raw: unknown): SkipSegment[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const segments: SkipSegment[] = [];

  for (const type of SKIP_TYPES) {
    const entry = obj[type];
    if (!entry || typeof entry !== 'object') continue;
    const { start, end } = entry as { start?: unknown; end?: unknown };
    if (!isFiniteNumber(start) || !isFiniteNumber(end)) continue;
    if (end <= start) continue;
    segments.push({ type: type as SkipType, start, end });
  }

  return segments.sort((a, b) => a.start - b.start);
}
