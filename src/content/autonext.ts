/**
 * Auto-play the next episode.
 *
 * Crunchyroll shows an "Up Next" card near the end of an episode with a button
 * to continue. Rather than navigate ourselves (URL of the next episode isn't
 * reliably derivable), we click that native control when it appears after the
 * video ends — this also respects CR's own "are you still watching" gating.
 */

const NEXT_TEXT = /\b(next episode|up next|play next)\b/i;

export function findNextButton(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[data-testid*="next" i], button, [role="button"], a',
  );
  for (const el of candidates) {
    const label =
      (el.getAttribute('aria-label') ?? '') +
      ' ' +
      (el.getAttribute('title') ?? '') +
      ' ' +
      (el.textContent ?? '');
    if (NEXT_TEXT.test(label)) return el;
  }
  return null;
}

export interface AutoNextController {
  detach: () => void;
}

export function attachAutoNext(
  video: HTMLVideoElement,
  enabled: () => boolean,
): AutoNextController {
  let tries = 0;
  let pollId: number | undefined;

  const stopPolling = () => {
    if (pollId !== undefined) {
      window.clearInterval(pollId);
      pollId = undefined;
    }
  };

  const onEnded = () => {
    if (!enabled()) return;
    tries = 0;
    stopPolling();
    // The "Up Next" button can take a beat to render after `ended`.
    pollId = window.setInterval(() => {
      tries += 1;
      const btn = findNextButton();
      if (btn) {
        btn.click();
        stopPolling();
      } else if (tries > 20) {
        stopPolling();
      }
    }, 300);
  };

  video.addEventListener('ended', onEnded);
  return {
    detach: () => {
      video.removeEventListener('ended', onEnded);
      stopPolling();
    },
  };
}
