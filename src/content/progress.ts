import { sendEpisodeWatched } from '@/shared/messages';
import { log } from '@/shared/log';

/**
 * Fire once per episode, shortly after the viewer has *started* it, so the
 * tracker reflects the episode they're currently on. We deliberately don't wait
 * until ~80% through: when you advance from episode 5 to 6, you want MAL to read
 * 6 soon after 6 begins, not a whole episode behind. The small grace period
 * (real playback past `STARTED_SECONDS`) confirms you're actually watching it
 * and not just clicking past — an accidental peek won't bump your count.
 */
const STARTED_SECONDS = 30;

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
    if (!Number.isFinite(duration) || duration <= 0) return; // wait for real media
    if (currentTime >= STARTED_SECONDS) {
      fired = true;
      log('episode started -> updating tracker to this episode', episodeId);
      sendEpisodeWatched(episodeId);
    }
  };

  // Re-arm when new media loads into the SAME <video> element. If Crunchyroll's
  // player reuses the element across an auto-advance (rather than recreating it),
  // our session may not tear down/re-attach — without this the one-shot `fired`
  // flag would stay true and the next episode would never report as watched.
  const onNewMedia = () => {
    fired = false;
  };

  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('loadstart', onNewMedia);
  video.addEventListener('emptied', onNewMedia);
  return {
    detach: () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadstart', onNewMedia);
      video.removeEventListener('emptied', onNewMedia);
    },
  };
}
