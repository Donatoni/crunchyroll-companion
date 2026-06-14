import { seekTo } from './player';
import { showToast } from './toast';
import { bumpSkip } from '@/shared/stats';
import { log } from '@/shared/log';
import type { Settings } from '@/shared/settings';
import { SKIP_LABELS, type SkipSegment } from '@/shared/types';

/**
 * Core auto-skip engine (seek mode).
 *
 * Attaches a timeupdate listener (fires ~4Hz) and seeks past enabled segments. Each
 * segment is skipped at most once ("consumed") so a user who manually rewinds
 * into a segment is not fought. "Undo" restores the playhead and permanently
 * un-consumes that segment for the rest of the episode.
 */
export interface SkipEngine {
  detach: () => void;
}

export function attachSkipEngine(
  video: HTMLVideoElement,
  segments: SkipSegment[],
  getSettings: () => Settings,
): SkipEngine {
  if (segments.length === 0) {
    return { detach: () => {} };
  }

  const consumed = new Set<SkipSegment>();
  // A small lead-in lets us catch the segment even if timeupdate fires sparsely.
  const ENTER_EPS = 0.5;

  const onTimeUpdate = () => {
    const settings = getSettings();
    if (!settings.enabled || settings.mode !== 'seek') return;

    const t = video.currentTime;
    for (const seg of segments) {
      if (consumed.has(seg)) continue;
      if (!settings.skip[seg.type]) continue;
      if (t + ENTER_EPS >= seg.start && t < seg.end) {
        consumed.add(seg);
        const from = t;
        log(
          'seek-skip',
          seg.type,
          `${seg.start.toFixed(1)}→${seg.end.toFixed(1)}s (at ${from.toFixed(1)}s)`,
        );
        seekTo(video, seg.end);
        void bumpSkip(seg.end - from);

        if (settings.showToast) {
          showToast({
            message: `Skipped ${SKIP_LABELS[seg.type].toLowerCase()}`,
            actionLabel: 'Undo',
            onAction: () => {
              // Restore position and never auto-skip this segment again.
              video.currentTime = from;
              // consumed already has seg; leaving it ensures no re-skip.
            },
          });
        }
        break; // one skip per tick
      }
    }
  };

  video.addEventListener('timeupdate', onTimeUpdate);
  return {
    detach: () => video.removeEventListener('timeupdate', onTimeUpdate),
  };
}
