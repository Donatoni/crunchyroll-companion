import { sendEpisodeWatched } from '@/shared/messages';
import { log } from '@/shared/log';

/**
 * Fire once per episode when the viewer has watched "enough" of it, so the
 * background can sync progress to the tracker. Threshold mirrors typical tracker
 * behaviour: 80% watched (or within the last 60s for long episodes).
 */
const WATCHED_FRACTION = 0.8;

export interface ProgressController {
  detach: () => void;
}

export function attachProgress(
  video: HTMLVideoElement,
  episodeId: string,
  enabled: () => boolean,
): ProgressController {
  let fired = false;

  const onTimeUpdate = () => {
    if (fired || !enabled()) return;
    const { currentTime, duration } = video;
    if (!duration || !Number.isFinite(duration)) return;
    const watchedEnough =
      currentTime / duration >= WATCHED_FRACTION || duration - currentTime <= 60;
    if (watchedEnough) {
      fired = true;
      log('watched threshold reached -> notifying tracker', episodeId);
      sendEpisodeWatched(episodeId);
    }
  };

  video.addEventListener('timeupdate', onTimeUpdate);
  return { detach: () => video.removeEventListener('timeupdate', onTimeUpdate) };
}
