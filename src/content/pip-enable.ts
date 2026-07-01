/**
 * Crunchyroll ships its <video> with `disablePictureInPicture` set, which both
 * hides the browser's PiP affordance and makes requestPictureInPicture() throw.
 * Force it back off and keep it off — the player can re-apply the flag on React
 * re-renders, so we watch the attribute and clear it again whenever it returns.
 *
 * Shared by the manual button and Auto-PiP so both see a PiP-capable element.
 */
export function keepPipEnabled(video: HTMLVideoElement): { detach: () => void } {
  const clear = () => {
    if (video.disablePictureInPicture) video.disablePictureInPicture = false;
    if (video.hasAttribute('disablepictureinpicture')) {
      video.removeAttribute('disablepictureinpicture');
    }
  };
  clear();

  const obs = new MutationObserver(clear);
  obs.observe(video, {
    attributes: true,
    attributeFilter: ['disablepictureinpicture'],
  });
  // Belt-and-suspenders: also re-clear when a new source starts playing.
  video.addEventListener('loadedmetadata', clear);
  video.addEventListener('play', clear);

  return {
    detach() {
      obs.disconnect();
      video.removeEventListener('loadedmetadata', clear);
      video.removeEventListener('play', clear);
    },
  };
}
