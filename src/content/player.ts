/**
 * Locates and wraps Crunchyroll's HTML5 <video> element.
 *
 * The player can live in the page or in a same-origin iframe; because our content
 * script runs with all_frames, each frame finds its own video. We poll briefly
 * because the <video> is mounted asynchronously after navigation.
 */

export type VideoCallback = (video: HTMLVideoElement) => void;

/** Resolve the player's <video>, retrying until it exists or we give up. */
export function waitForVideo(
  onVideo: VideoCallback,
  { timeoutMs = 30_000, intervalMs = 400 } = {},
): () => void {
  let cancelled = false;
  const existing = document.querySelector<HTMLVideoElement>('video');
  if (existing) {
    onVideo(existing);
    return () => {};
  }

  const start = performance.now();
  const id = window.setInterval(() => {
    if (cancelled) return;
    const video = document.querySelector<HTMLVideoElement>('video');
    if (video) {
      window.clearInterval(id);
      onVideo(video);
    } else if (performance.now() - start > timeoutMs) {
      window.clearInterval(id);
    }
  }, intervalMs);

  return () => {
    cancelled = true;
    window.clearInterval(id);
  };
}

/** Seek the video forward to `time` (seconds). No-op if already past it. */
export function seekTo(video: HTMLVideoElement, time: number): void {
  if (!Number.isFinite(time)) return;
  if (video.currentTime < time) {
    video.currentTime = time;
  }
}
