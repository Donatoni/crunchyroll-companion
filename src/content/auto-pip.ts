/**
 * Auto Picture-in-Picture: when the user switches away from the Crunchyroll tab
 * while an episode is playing, pop the <video> out into a floating window so they
 * can keep watching.
 *
 * The enter path uses the mechanism Chrome actually permits without a fresh page
 * gesture: register a `mediaSession` "enterpictureinpicture" action handler and
 * mark the video `autopictureinpicture`. Chrome then invokes the handler itself
 * when the tab is hidden. (A plain visibilitychange → requestPictureInPicture()
 * is rejected as a gesture violation, which is why the first attempt did nothing.)
 *
 * We deliberately DON'T auto-close the window on return: calling
 * exitPictureInPicture() programmatically leaves Crunchyroll's player stuck in its
 * "playing in picture-in-picture" state with a blank main video. Instead the PiP
 * window stays until the user closes it via its own "back to tab" control, which
 * the player restores from correctly.
 *
 * Caveat: Chrome only browser-initiates Auto-PiP for media in the TOP frame. If
 * Crunchyroll serves the player from a cross-origin iframe, this won't fire — the
 * manual PiP button (see pip-button.ts) covers that case.
 */
export function attachAutoPip(
  video: HTMLVideoElement,
  isEnabled: () => boolean,
): { detach: () => void } {
  const canPip = () => document.pictureInPictureEnabled;

  // Keep the element's Auto-PiP eligibility in sync with the setting.
  function applyAttr(): void {
    if (isEnabled() && canPip()) video.setAttribute('autopictureinpicture', '');
    else video.removeAttribute('autopictureinpicture');
  }

  async function enter(): Promise<void> {
    if (!isEnabled() || !canPip()) return;
    if (document.pictureInPictureElement) return; // already floating
    // Only pop out a video that's genuinely playing — not paused, ended, or
    // still buffering with nothing to show.
    if (video.paused || video.ended || video.readyState < 2) return;
    try {
      await video.requestPictureInPicture();
    } catch {
      /* rejected — nothing to do */
    }
  }

  // Chrome calls this automatically when the tab is hidden; the request inside is
  // treated as browser-initiated, so no page gesture is required.
  const ms = navigator.mediaSession as MediaSession | undefined;
  const hasMediaSession = !!ms && typeof ms.setActionHandler === 'function';
  const setAction = (h: (() => void) | null) => {
    // 'enterpictureinpicture' isn't in the lib.dom action union yet.
    try {
      (ms!.setActionHandler as (a: string, h: (() => void) | null) => void)(
        'enterpictureinpicture',
        h,
      );
    } catch {
      /* unsupported action — ignore */
    }
  };
  if (hasMediaSession) setAction(() => void enter());

  // Re-sync eligibility whenever playback (re)starts and at attach time.
  const onPlay = () => applyAttr();

  applyAttr();
  video.addEventListener('play', onPlay);

  return {
    detach() {
      video.removeEventListener('play', onPlay);
      video.removeAttribute('autopictureinpicture');
      if (hasMediaSession) setAction(null);
    },
  };
}
