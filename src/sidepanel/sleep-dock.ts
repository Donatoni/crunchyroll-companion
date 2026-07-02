/**
 * Sleep timer dock: a small panel toggled by the footer moon icon, available
 * from every view (kept out of the show page to avoid clutter). Sets/clears
 * the shared sleep timer that the content script's auto-next gate consumes.
 */
import {
  clearSleepTimer,
  getSleepTimer,
  onSleepTimerChanged,
  setSleepTimer,
  type SleepTimer,
} from '@/shared/sleep-timer';
import { $ } from './helpers';

const moonBtn = $<HTMLButtonElement>('#open-sleep');
const dock = $('#sleepDock');
const sleepStatus = $('#sleepStatus');
const sleepChips = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#sleepChips .sleep-chip'),
);

function setOpen(open: boolean): void {
  dock.hidden = !open;
  moonBtn.setAttribute('aria-expanded', String(open));
}

moonBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // keep the document click-away handler from re-closing
  setOpen(dock.hidden);
});
// Click-away and Escape both dismiss (matching the status/score menus).
document.addEventListener('click', (e) => {
  if (!dock.hidden && !dock.contains(e.target as Node)) setOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !dock.hidden) {
    setOpen(false);
    moonBtn.focus();
  }
});

/**
 * Reflect the stored timer: highlight the matching chip, show the remaining
 * count, and light the moon up while a timer is armed. After a decrement
 * (set 3, one auto-advance → 2) the matching count chip still highlights, so
 * the control reads as live state, not just the last tap.
 */
function renderSleepTimer(t: SleepTimer | null): void {
  moonBtn.classList.toggle('on', t != null);
  for (const chip of sleepChips) {
    const eps = chip.dataset.eps ?? '';
    const sel = t == null ? eps === '' : eps !== '' && Number(eps) === t.remaining;
    chip.classList.toggle('sel', sel);
    chip.setAttribute('aria-checked', String(sel));
  }
  if (t == null) {
    sleepStatus.hidden = true;
  } else {
    sleepStatus.textContent =
      t.remaining > 0
        ? `${t.remaining} ep${t.remaining === 1 ? '' : 's'} left 🌙`
        : 'stopping after this episode 🌙';
    sleepStatus.hidden = false;
  }
}

for (const chip of sleepChips) {
  chip.setAttribute('role', 'radio');
  chip.addEventListener('click', () => {
    const eps = chip.dataset.eps ?? '';
    if (eps === '') void clearSleepTimer();
    else void setSleepTimer(Number(eps));
    // Storage listener below repaints; this just makes the tap feel instant.
    renderSleepTimer(eps === '' ? null : { remaining: Number(eps), setAt: Date.now() });
  });
}
getSleepTimer()
  .then(renderSleepTimer)
  .catch(() => {});
onSleepTimerChanged(renderSleepTimer);
