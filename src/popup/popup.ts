import { getSettings, patchSettings, type Settings } from '@/shared/settings';
import type { SkipType } from '@/shared/types';
import type {
  ContentStatusRequest,
  TabStatusResponse,
} from '@/shared/messages';
import { formatSaved, getStats } from '@/shared/stats';

const enabledEl = document.querySelector<HTMLInputElement>('#enabled')!;
const stateEl = document.querySelector<HTMLDivElement>('#state')!;
const skipEls = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[data-skip]'),
);

/** Boolean settings bound to a checkbox by element id. */
const boolKeys = ['autoNext'] as const;
const boolEls = Object.fromEntries(
  boolKeys.map((k) => [k, document.querySelector<HTMLInputElement>(`#${k}`)!]),
) as Record<(typeof boolKeys)[number], HTMLInputElement>;

function applyEnabledUI(enabled: boolean): void {
  stateEl.textContent = enabled ? 'Active' : 'Paused';
  document.body.classList.toggle('disabled', !enabled);
}

async function render(): Promise<void> {
  const s = await getSettings();
  enabledEl.checked = s.enabled;
  for (const k of boolKeys) boolEls[k].checked = s[k] as boolean;
  for (const el of skipEls) el.checked = s.skip[el.dataset.skip as SkipType];
  applyEnabledUI(s.enabled);
}

async function renderStats(): Promise<void> {
  const s = await getStats();
  const el = document.querySelector<HTMLSpanElement>('#stats')!;
  el.textContent =
    s.skips > 0
      ? `${s.skips} skips · saved ${formatSaved(s.secondsSaved)}`
      : 'No skips yet';
}

async function renderStatus(): Promise<void> {
  const titleEl = document.querySelector<HTMLDivElement>('#statusTitle')!;
  const dotEl = document.querySelector<HTMLSpanElement>('#statusDot')!;
  const subEl = document.querySelector<HTMLSpanElement>('#statusSub')!;
  const thumbEl = document.querySelector<HTMLDivElement>('#statusThumb')!;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    // Ask the content script on the page directly — it always has live episode
    // data, unlike the service worker's cache which is cleared when it sleeps.
    const st = await chrome.tabs.sendMessage<ContentStatusRequest, TabStatusResponse>(
      tab.id,
      { type: 'GET_STATUS' },
    );
    if (!st?.meta) return;

    const { series, season, episode, thumbnail } = st.meta;
    const se = [season ? `S${season}` : null, episode ? `E${episode}` : null]
      .filter(Boolean)
      .join(' ');
    titleEl.textContent = `Now watching${se ? ` · ${se}` : ''}`;
    titleEl.title = series;
    if (thumbnail) {
      thumbEl.style.backgroundImage = `url("${thumbnail}")`;
      thumbEl.style.backgroundSize = 'cover';
      thumbEl.style.backgroundPosition = 'center';
    }
    if (st.segments > 0) {
      dotEl.classList.remove('idle');
      subEl.textContent = `Skip data found · ${st.segments} segment${
        st.segments === 1 ? '' : 's'
      }`;
    } else {
      dotEl.classList.add('idle');
      subEl.textContent = 'No skip data for this episode';
    }
  } catch {
    /* not on a watch page / worker asleep — leave the default idle state */
  }
}

enabledEl.addEventListener('change', async () => {
  await patchSettings({ enabled: enabledEl.checked });
  applyEnabledUI(enabledEl.checked);
});

for (const k of boolKeys) {
  boolEls[k].addEventListener('change', () =>
    patchSettings({ [k]: boolEls[k].checked } as Partial<Settings>),
  );
}

for (const el of skipEls) {
  el.addEventListener('change', async () => {
    const current = (await getSettings()).skip;
    await patchSettings({
      skip: { ...current, [el.dataset.skip as SkipType]: el.checked },
    });
  });
}

document.querySelector('#open-options')!.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void render();
void renderStats();
void renderStatus();
