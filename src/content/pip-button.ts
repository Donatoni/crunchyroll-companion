/**
 * A Picture-in-Picture control for the player. Clicking it pops the <video> out
 * (or back in) — and because the click is a real user gesture in the video's own
 * document, requestPictureInPicture() is always allowed.
 *
 * Preferred rendering: clone one of Crunchyroll's own control buttons (fullscreen)
 * so we inherit its exact size, spacing and circular hover effect, re-skin it with
 * a PiP glyph, and slot it into the control bar just before fullscreen (i.e.
 * between settings and fullscreen). The player re-renders its controls, so we
 * re-inject whenever our button goes missing.
 *
 * Fallback: if the control bar can't be located, float a self-styled button over
 * the top-right of the video so PiP is still reachable.
 *
 * Assumes disablePictureInPicture has been cleared (see keepPipEnabled).
 */

const BTN_ID = 'crunchyroll-companion-pip-btn';
const FULLSCREEN_RE = /full\s*screen/i;

// Inner paths for a 0 0 24 24 viewBox: a screen with an inset window bottom-right.
const PIP_PATHS =
  '<path d="M21 3H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h6v-2H4V5h16v5h2V4a1 1 0 0 0-1-1z" fill="currentColor"/>' +
  '<rect x="12" y="11" width="10" height="8" rx="1" fill="currentColor"/>';
const PIP_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">${PIP_PATHS}</svg>`;

export function attachPipButton(video: HTMLVideoElement): { detach: () => void } {
  // Nothing to toggle if the browser itself can't do PiP.
  if (!document.pictureInPictureEnabled) {
    return { detach() {} };
  }

  const inPip = () => document.pictureInPictureElement === video;
  async function toggle(e: Event): Promise<void> {
    // Don't let the click reach the player (which would toggle play/pause or
    // fullscreen on the cloned button).
    e.preventDefault();
    e.stopPropagation();
    try {
      if (inPip()) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      /* rejected (rare) — nothing to do */
    }
  }

  document.getElementById(BTN_ID)?.remove();

  // ── native control-bar injection ────────────────────────────────────
  /** First element whose accessible name matches, that looks like a control. */
  function findControl(re: RegExp): HTMLElement | null {
    for (const el of document.querySelectorAll<HTMLElement>('[aria-label],[title]')) {
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      if (re.test(name) && el.querySelector('svg')) return el;
    }
    return null;
  }

  /** Re-skin a cloned native control into our PiP button. */
  function reskin(el: HTMLElement): void {
    el.id = BTN_ID;
    el.setAttribute('aria-label', 'Picture-in-picture');
    el.setAttribute('title', 'Picture-in-picture');
    el.removeAttribute('data-testid');
    const svg = el.querySelector('svg');
    if (svg) {
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.removeAttribute('data-testid'); // was enter-fullscreen-icon
      // eslint-disable-next-line no-unsanitized/property -- PIP_PATHS is a module const literal
      svg.innerHTML = PIP_PATHS;
    } else {
      // eslint-disable-next-line no-unsanitized/property -- PIP_SVG is a module const literal
      el.innerHTML = PIP_SVG;
    }
    // Clones can carry a stale "active/pressed" class; PiP has no toggled state.
    el.removeAttribute('aria-pressed');
    el.addEventListener('click', (e) => void toggle(e), true);
  }

  let mode: 'none' | 'native' | 'float' = 'none';

  /**
   * Ensure the native button exists; returns true once injected. Each control
   * lives in its own wrapper div inside the flex control row, so we add a sibling
   * wrapper (a clone of fullscreen's) right before fullscreen's — putting PiP
   * between settings and fullscreen without disturbing their layout.
   */
  function ensureNative(): boolean {
    if (document.getElementById(BTN_ID)?.isConnected) return true;
    const fs = findControl(FULLSCREEN_RE);
    const fsWrapper = fs?.parentElement;
    const row = fsWrapper?.parentElement;
    if (!fs || !fsWrapper || !row) return false;
    const clone = fs.cloneNode(true) as HTMLElement;
    reskin(clone);
    const wrapper = document.createElement('div');
    wrapper.className = fsWrapper.className; // mirror the per-control wrapper
    wrapper.setAttribute('data-cc-pip', '');
    wrapper.appendChild(clone);
    row.insertBefore(wrapper, fsWrapper);
    mode = 'native';
    return true;
  }

  // ── floating fallback ───────────────────────────────────────────────
  let floatBtn: HTMLButtonElement | null = null;
  function placeFloat(): void {
    if (!floatBtn) return;
    const host = (document.fullscreenElement as HTMLElement | null) ?? document.documentElement;
    if (floatBtn.parentElement !== host) host.appendChild(floatBtn);
    const r = video.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) {
      floatBtn.style.display = 'none';
      return;
    }
    floatBtn.style.display = 'flex';
    floatBtn.style.top = `${Math.round(r.top + 12)}px`;
    floatBtn.style.left = `${Math.round(r.right - 40 - 12)}px`;
  }
  function startFloat(): void {
    if (floatBtn) return;
    mode = 'float';
    const b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.title = 'Picture-in-picture';
    b.setAttribute('aria-label', 'Picture-in-picture');
    Object.assign(b.style, {
      position: 'fixed', top: '0', left: '0', zIndex: '2147483647',
      display: 'none', alignItems: 'center', justifyContent: 'center',
      width: '40px', height: '40px', padding: '0', margin: '0', border: 'none',
      borderRadius: '8px', background: 'rgba(20,20,24,0.72)', color: '#fff',
      cursor: 'pointer', opacity: '0.9', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      transition: 'background .15s ease',
    } satisfies Partial<CSSStyleDeclaration>);
    // eslint-disable-next-line no-unsanitized/property -- PIP_SVG is a module const literal
    b.innerHTML = PIP_SVG;
    b.addEventListener('mouseenter', () => (b.style.background = '#f47521'));
    b.addEventListener('mouseleave', () => (b.style.background = 'rgba(20,20,24,0.72)'));
    b.addEventListener('click', (e) => void toggle(e));
    floatBtn = b;
    window.addEventListener('scroll', placeFloat, true);
    window.addEventListener('resize', placeFloat);
    document.addEventListener('fullscreenchange', placeFloat);
    placeFloat();
  }

  // ── drive it ────────────────────────────────────────────────────────
  // Poll: (re)inject the native button when possible; after a grace period with
  // no control bar found, fall back to the floating button.
  let elapsed = 0;
  const tick = window.setInterval(() => {
    elapsed += 700;
    if (mode === 'float') {
      placeFloat();
      return;
    }
    if (ensureNative()) return;
    if (elapsed >= 6000) startFloat(); // control bar never appeared
  }, 700);

  ensureNative();

  return {
    detach() {
      window.clearInterval(tick);
      window.removeEventListener('scroll', placeFloat, true);
      window.removeEventListener('resize', placeFloat);
      document.removeEventListener('fullscreenchange', placeFloat);
      // Native button sits in a wrapper we added; the float button stands alone.
      document.querySelector('[data-cc-pip]')?.remove();
      document.getElementById(BTN_ID)?.remove();
      floatBtn = null;
    },
  };
}
