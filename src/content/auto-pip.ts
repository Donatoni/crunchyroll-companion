/**
 * Auto Picture-in-Picture: when the user switches away from the Crunchyroll tab
 * while an episode is playing, pop the <video> out into a floating window so they
 * can keep watching, then close it again on return.
 *
 * The enter path uses the mechanism Chrome actually permits without a fresh page
 * gesture: register a `mediaSession` "enterpictureinpicture" action handler and
 * mark the video `autopictureinpicture`. Chrome then invokes the handler itself
 * when the tab is hidden. (A plain visibilitychange → requestPictureInPicture()
 * is rejected as a gesture violation, which is why the first attempt did nothing.)
 *
 * Caveat: Chrome only browser-initiates Auto-PiP for media in the TOP frame. If
 * Crunchyroll serves the player from a cross-origin iframe, this won't fire — the
 * manual PiP button (see pip-button.ts) covers that case.
 */
export function attachAutoPip(
  video: HTMLVideoElement,
  isEnabled: () => boolean,
): { detach: () => void } {
  // True only while a PiP window WE auto-opened is up, so we close ours on return
  // and leave a user-opened one (via the button / native control) alone.
  let openedByUs = false;

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
      openedByUs = true;
    } catch {
      /* rejected — nothing to do */
    }
  }

  // Chrome calls this automatically when the tab is hidden; the request inside is
  // treated as browser-initiated, so no page gesture is required.
  const ms = navigator.mediaSession as MediaSession | undefined;
  const hasMediaSession = !!ms && typeof ms.setActionHandler === 'function';
  if (hasMediaSession) {
    // 'enterpictureinpicture' isn't in the lib.dom action union yet.
    try {
      (ms!.setActionHandler as (a: string, h: (() => void) | null) => void)(
        'enterpictureinpicture',
        () => void enter(),
      );
    } catch {
      /* unsupported action — ignore */
    }
  }

  // Returning to the tab closes the window we opened (exit needs no gesture).
  const onVisibility = () => {
    if (document.visibilityState !== 'visible' || !openedByUs) return;
    openedByUs = false;
    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
    }
  };
  // If the user closes the window themselves, stop considering it ours.
  const onLeave = () => {
    openedByUs = false;
  };
  // Re-sync eligibility whenever playback (re)starts and at attach time.
  const onPlay = () => applyAttr();

  applyAttr();
  document.addEventListener('visibilitychange', onVisibility);
  video.addEventListener('leavepictureinpicture', onLeave);
  video.addEventListener('play', onPlay);

  return {
    detach() {
      document.removeEventListener('visibilitychange', onVisibility);
      video.removeEventListener('leavepictureinpicture', onLeave);
      video.removeEventListener('play', onPlay);
      video.removeAttribute('autopictureinpicture');
      if (hasMediaSession) {
        try {
          (ms!.setActionHandler as (a: string, h: (() => void) | null) => void)(
            'enterpictureinpicture',
            null,
          );
        } catch {
          /* ignore */
        }
      }
    },
  };
}
