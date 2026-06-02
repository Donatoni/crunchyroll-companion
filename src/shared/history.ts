/**
 * Local "continue watching" history. Each opened episode is recorded (one entry
 * per series — the latest episode you were on), newest first, in storage.local.
 */
import { isExtensionContextValid } from './runtime';

const KEY = 'history';
const MAX = 30;

export interface HistoryEntry {
  episodeId: string;
  url: string;
  series: string;
  episodeTitle: string;
  episode: number | null;
  season: number | null;
  thumbnail: string;
  /** Epoch ms when last opened. */
  updatedAt: number;
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const r = await chrome.storage.local.get(KEY);
  const list = (r[KEY] as HistoryEntry[] | undefined) ?? [];
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Upsert an entry, keyed by series, moving it to the front. */
export async function recordHistory(
  entry: Omit<HistoryEntry, 'updatedAt'>,
): Promise<void> {
  if (!entry.series) return;
  if (!isExtensionContextValid()) return; // orphaned content script
  try {
    const r = await chrome.storage.local.get(KEY);
    const list = (r[KEY] as HistoryEntry[] | undefined) ?? [];
    const key = entry.series.trim().toLowerCase();
    const next: HistoryEntry[] = [
      { ...entry, updatedAt: Date.now() },
      ...list.filter((e) => e.series.trim().toLowerCase() !== key),
    ].slice(0, MAX);
    await chrome.storage.local.set({ [KEY]: next });
  } catch {
    /* extension context invalidated — ignore */
  }
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
