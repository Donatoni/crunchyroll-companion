import type { SkipType } from './types';

/** How skips are performed. */
export type SkipMode = 'seek' | 'click';

export interface Settings {
  /** Master on/off for the whole extension. */
  enabled: boolean;
  /** Per-segment auto-skip toggles. */
  skip: Record<SkipType, boolean>;
  /**
   * When true, don't auto-skip anything on episode 1 (of a season) — so the
   * opening plays the first time through — and skip normally from episode 2 on.
   */
  skipAfterFirstOnly: boolean;
  /** Auto-play the next episode when one finishes. */
  autoNext: boolean;
  /** Pop the video into Picture-in-Picture when you switch away from the tab. */
  autoPip: boolean;
  /** Dismiss "are you still watching?" / profile prompts to keep playback going. */
  keepWatching: boolean;
  /** Show a "Skipped X — Undo" toast after each skip. */
  showToast: boolean;
  /**
   * 'seek'  = use skip-events timestamps and seek the <video> directly,
   *           falling back to clicking the native button when no data exists.
   * 'click' = only ever click Crunchyroll's native skip button.
   */
  mode: SkipMode;
  /** MyAnimeList progress-sync configuration. */
  mal: {
    /** Sync watched episodes to MyAnimeList. */
    enabled: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  skip: {
    intro: true,
    recap: true,
    credits: true,
    preview: true,
  },
  skipAfterFirstOnly: false,
  autoNext: true,
  autoPip: false,
  keepWatching: true,
  showToast: true,
  mode: 'seek',
  mal: {
    enabled: false,
  },
};

const STORAGE_KEY = 'settings';

/** Merge stored partial settings over defaults so new fields always have a value. */
function withDefaults(stored: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    skip: { ...DEFAULT_SETTINGS.skip, ...(stored?.skip ?? {}) },
    mal: { ...DEFAULT_SETTINGS.mal, ...(stored?.mal ?? {}) },
  };
}

export async function getSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get(STORAGE_KEY);
  return withDefaults(raw[STORAGE_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = withDefaults({ ...(await getSettings()), ...patch });
  await saveSettings(next);
  return next;
}

/**
 * Subscribe to live settings changes. Returns an unsubscribe function.
 * Used by the content script so side-panel toggles apply without a reload.
 */
export function onSettingsChanged(cb: (settings: Settings) => void): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    area: string,
  ) => {
    if (area !== 'sync' || !(STORAGE_KEY in changes)) return;
    cb(withDefaults(changes[STORAGE_KEY].newValue as Partial<Settings> | undefined));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
