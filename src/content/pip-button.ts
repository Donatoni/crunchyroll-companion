/**
 * A self-contained Picture-in-Picture button overlaid on the player. Clicking it
 * pops the current <video> out (or back in) — and because the click is a real
 * user gesture in the video's own document, requestPictureInPicture() is always
 * allowed, unlike the browser-initiated Auto-PiP path.
 *
 * The button is a single fixed-position element positioned over the top-right of
 * the video's bounding box (re-parented into the fullscreen element while
 * fullscreen so it stays visible). It's shown whenever the video is on screen and
 * brightens on hover. Styles are inline so they survive Crunchyroll's CSP and
 * never collide with its stylesheet.
 *
 * Assumes disablePictureInPicture has been cleared (see keepPipEnabled).
 */

const BTN_ID = 'crunchyroll-companion-pip-btn';

const IDLE_BG = 'rgba(20, 20, 24, 0.72)';
const HOVER_BG = '#f47521'; // Crunchyroll orange

// Screen-with-inset-window glyph. Filled so it reads at small sizes.
const PIP_SVG =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<path d="M21 3H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h6v-2H4V5h16v5h2V4a1 1 0 0 0-1-1z" fill="currentColor"/>' +
  '<rect x="12" y="11" width="10" height="8" rx="1" fill="currentColor"/></svg>';

export function attachPipButton(video: HTMLVideoElement): { detach: () => void } {
  // Nothing to toggle if the browser itself can't do PiP.
  if (!document.pictureInPictureEnabled) {
    return { detach() {} };
  }

  // Replace any stale button from a previous session in this frame.
  document.getElementById(BTN_ID)?.remove();

  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.title = 'Picture-in-picture';
  btn.setAttribute('aria-label', 'Picture-in-picture');
  Object.assign(btn.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '2147483647',
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    padding: '0',
    margin: '0',
    border: 'none',
    borderRadius: '8px',
    background: IDLE_BG,
    color: '#fff',
    cursor: 'pointer',
    opacity: '0.9',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    transition: 'background .15s ease, opacity .15s ease',
  } satisfies Partial<CSSStyleDeclaration>);
  btn.innerHTML = PIP_SVG;

  const inPip = () => document.pictureInPictureElement === video;
  const paint = () => {
    btn.style.background = inPip() ? HOVER_BG : IDLE_BG;
  };

  btn.addEventListener('mouseenter', () => (btn.style.background = HOVER_BG));
  btn.addEventListener('mouseleave', paint);

  btn.addEventListener('click', async (e) => {
    // Don't let the click reach the player (which would toggle play/pause).
    e.preventDefault();
    e.stopPropagation();
    try {
      if (inPip()) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      /* rejected (rare) — nothing to do */
    }
  });

  // ── placement ──────────────────────────────────────────────────────
  // Host under the fullscreen element while fullscreen so a fixed child still
  // renders; otherwise the document root, matching the toast.
  function place(): void {
    const host = (document.fullscreenElement as HTMLElement | null) ?? document.documentElement;
    if (btn.parentElement !== host) host.appendChild(btn);
    const r = video.getBoundingClientRect();
    // Hide over a hidden/tiny/off-screen video (e.g. between episodes).
    if (r.width < 80 || r.height < 60) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = 'flex';
    btn.style.top = `${Math.round(r.top + 12)}px`;
    btn.style.left = `${Math.round(r.right - 40 - 12)}px`;
  }

  const reposition = () => place();

  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  document.addEventListener('fullscreenchange', reposition);
  video.addEventListener('enterpictureinpicture', paint);
  video.addEventListener('leavepictureinpicture', paint);
  // The player mounts/resizes the video asynchronously; keep the overlay pinned.
  const ro = new ResizeObserver(reposition);
  ro.observe(video);
  // Cheap safety net for layout shifts no event covers (e.g. sidebar toggles).
  const tick = window.setInterval(reposition, 1000);

  place();

  return {
    detach() {
      window.clearInterval(tick);
      ro.disconnect();
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      document.removeEventListener('fullscreenchange', reposition);
      video.removeEventListener('enterpictureinpicture', paint);
      video.removeEventListener('leavepictureinpicture', paint);
      btn.remove();
    },
  };
}
