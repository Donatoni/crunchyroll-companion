import { requestSkipEvents } from '@/shared/messages';
import type { SkipSegment } from '@/shared/types';

/**
 * Content-side accessor for skip-events data. Delegates the actual network call
 * to the service worker (avoids CORS), and caches per episode for this frame.
 */
const frameCache = new Map<string, SkipSegment[]>();

export async function getSkipSegments(episodeId: string): Promise<SkipSegment[]> {
  if (frameCache.has(episodeId)) return frameCache.get(episodeId)!;
  try {
    const res = await requestSkipEvents(episodeId);
    const segments = res.ok ? res.segments : [];
    frameCache.set(episodeId, segments);
    return segments;
  } catch {
    // Worker asleep / messaging error — caller falls back to DOM clicking.
    return [];
  }
}
