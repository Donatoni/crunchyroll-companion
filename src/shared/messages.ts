import type { SkipSegment, TrackerMeta } from './types';

/**
 * Typed message contracts between content scripts and the background service
 * worker. The worker is the cross-frame hub: the top frame supplies episode
 * metadata, the player iframe supplies watch progress, and the worker correlates
 * them by tab to drive tracker sync.
 */

export interface FetchSkipEventsRequest {
  type: 'FETCH_SKIP_EVENTS';
  episodeId: string;
}
export interface FetchSkipEventsResponse {
  ok: boolean;
  segments: SkipSegment[];
  error?: string;
}

/** Top frame -> worker: metadata for the episode now showing in this tab. */
export interface EpisodeMetaMessage {
  type: 'EPISODE_META';
  meta: TrackerMeta;
}

/** Player iframe -> worker: this episode crossed the "watched" threshold. */
export interface EpisodeWatchedMessage {
  type: 'EPISODE_WATCHED';
  episodeId: string;
}

/** Worker -> top frame: show a toast (e.g. tracker result). */
export interface TrackerToastMessage {
  type: 'TRACKER_TOAST';
  text: string;
}

/** Popup -> worker: current episode status for a tab (for the status card). */
export interface TabStatusRequest {
  type: 'GET_TAB_STATUS';
  tabId: number;
}
export interface TabStatusResponse {
  meta: TrackerMeta | null;
  /** Number of skip segments known for the current episode (0 if none/unknown). */
  segments: number;
}

/**
 * Popup -> content script (top watch frame): live status for the page. Answered
 * by the content script itself (not the worker), so it survives worker sleep and
 * always reflects the current page.
 */
export interface ContentStatusRequest {
  type: 'GET_STATUS';
}

export type RuntimeMessage =
  | FetchSkipEventsRequest
  | EpisodeMetaMessage
  | EpisodeWatchedMessage
  | TabStatusRequest;

/** Promise wrapper around chrome.runtime.sendMessage for skip-events. */
export function requestSkipEvents(
  episodeId: string,
): Promise<FetchSkipEventsResponse> {
  return chrome.runtime.sendMessage<FetchSkipEventsRequest, FetchSkipEventsResponse>({
    type: 'FETCH_SKIP_EVENTS',
    episodeId,
  });
}

export function sendEpisodeMeta(meta: TrackerMeta): void {
  void chrome.runtime
    .sendMessage<EpisodeMetaMessage>({ type: 'EPISODE_META', meta })
    .catch(() => {});
}

export function sendEpisodeWatched(episodeId: string): void {
  void chrome.runtime
    .sendMessage<EpisodeWatchedMessage>({ type: 'EPISODE_WATCHED', episodeId })
    .catch(() => {});
}

export function requestTabStatus(tabId: number): Promise<TabStatusResponse> {
  return chrome.runtime.sendMessage<TabStatusRequest, TabStatusResponse>({
    type: 'GET_TAB_STATUS',
    tabId,
  });
}

