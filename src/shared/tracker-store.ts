import type { TrackerMeta } from './types';
import type { MalToken } from './mal';

/**
 * Device-local tracker state (chrome.storage.local): the MyAnimeList OAuth token
 * and the resolved CR-series -> MAL-anime mappings. Kept out of synced settings
 * because the token is a credential and mappings can grow.
 */
const TOKEN_KEY = 'mal_token';
const MAP_KEY = 'mal_mappings';

export interface TrackerMapping {
  /** MAL anime id this CR series+season maps to. */
  mediaId: number;
  /** Display title (for the options UI). */
  title: string;
  /** Total episodes in the MAL entry, if known (for COMPLETED detection). */
  episodes: number | null;
}

/** Stable key for a CR series + season. */
export function seriesKey(meta: Pick<TrackerMeta, 'series' | 'season'>): string {
  return `${meta.series.trim().toLowerCase()}__s${meta.season ?? 1}`;
}

export async function getTokenData(): Promise<MalToken | null> {
  const r = await chrome.storage.local.get(TOKEN_KEY);
  return (r[TOKEN_KEY] as MalToken | undefined) ?? null;
}
export async function setTokenData(token: MalToken): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}
export async function clearToken(): Promise<void> {
  await chrome.storage.local.remove(TOKEN_KEY);
}

export async function getMappings(): Promise<Record<string, TrackerMapping>> {
  const r = await chrome.storage.local.get(MAP_KEY);
  return (r[MAP_KEY] as Record<string, TrackerMapping> | undefined) ?? {};
}
export async function getMapping(key: string): Promise<TrackerMapping | null> {
  return (await getMappings())[key] ?? null;
}
export async function setMapping(key: string, value: TrackerMapping): Promise<void> {
  const all = await getMappings();
  all[key] = value;
  await chrome.storage.local.set({ [MAP_KEY]: all });
}
export async function removeMapping(key: string): Promise<void> {
  const all = await getMappings();
  delete all[key];
  await chrome.storage.local.set({ [MAP_KEY]: all });
}
