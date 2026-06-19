import type { SkipSegment, TrackerMeta } from './types';
import type { MalCharacter, MalListItem, MalRelated, MalReview, SeasonalItem } from './mal';
import { isExtensionContextValid } from './runtime';

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

/** Popup -> worker: the signed-in user's MAL list entry for the current show. */
export interface MalStatusRequest {
  type: 'GET_MAL_STATUS';
  meta: TrackerMeta;
}
export interface MalStatusResponse {
  ok: boolean;
  /** Whether a MAL account is connected (token present), regardless of match. */
  connected?: boolean;
  title?: string;
  /** MAL anime id (for linking to the show's page). */
  animeId?: number;
  total?: number | null;
  watched?: number;
  status?: string | null;
  score?: number | null;
  mean?: number | null;
  rewatching?: boolean;
  rewatchCount?: number;
  /** Rich show details (present on GET_MAL_STATUS, omitted after SET). */
  synopsis?: string;
  picture?: string | null;
  genres?: string[];
  rank?: number | null;
  mediaType?: string | null;
  year?: number | null;
  studios?: string[];
  related?: MalRelated[];
  /** Failure detail (HTTP status / message) when ok === false. */
  error?: string;
}

/** Side panel -> worker: character list (via Jikan) for an anime. */
export interface MalCharactersRequest {
  type: 'GET_MAL_CHARACTERS';
  animeId: number;
}
export interface MalCharactersResponse {
  ok: boolean;
  characters: MalCharacter[];
}

/** Side panel -> worker: featured reviews (via Jikan) for an anime. */
export interface MalReviewsRequest {
  type: 'GET_MAL_REVIEWS';
  animeId: number;
}
export interface MalReviewsResponse {
  ok: boolean;
  reviews: MalReview[];
  /** Link to the show's full reviews tab on MAL. */
  allUrl?: string;
}

/** Side panel -> worker: the signed-in user's list for a status (home dashboard). */
export interface MyListRequest {
  type: 'GET_MY_LIST';
  status: string;
}
export interface MyListResponse {
  ok: boolean;
  connected: boolean;
  items: MalListItem[];
}

/** Side panel -> worker: popular currently-airing shows (home discovery). */
export interface SeasonalRequest {
  type: 'GET_SEASONAL';
}
export interface SeasonalResponse {
  ok: boolean;
  items: SeasonalItem[];
}

/** Popup -> worker: edit the user's MAL list entry for the current show. */
export interface SetMalStatusRequest {
  type: 'SET_MAL_STATUS';
  meta: TrackerMeta;
  patch: {
    num_watched_episodes?: number;
    status?: string;
    score?: number;
    is_rewatching?: boolean;
    num_times_rewatched?: number;
  };
}

export type RuntimeMessage =
  | FetchSkipEventsRequest
  | EpisodeMetaMessage
  | EpisodeWatchedMessage
  | TabStatusRequest
  | MalStatusRequest
  | SetMalStatusRequest
  | MalCharactersRequest
  | MalReviewsRequest
  | MyListRequest
  | SeasonalRequest;

/** Promise wrapper around chrome.runtime.sendMessage for skip-events. */
export function requestSkipEvents(
  episodeId: string,
): Promise<FetchSkipEventsResponse> {
  // Never throw synchronously on an orphaned content script (see fireAndForget).
  if (!isExtensionContextValid()) return Promise.resolve({ ok: false, segments: [] });
  try {
    return chrome.runtime.sendMessage<FetchSkipEventsRequest, FetchSkipEventsResponse>({
      type: 'FETCH_SKIP_EVENTS',
      episodeId,
    });
  } catch {
    return Promise.resolve({ ok: false, segments: [] });
  }
}

/**
 * Fire-and-forget send that can't throw. `sendMessage` throws *synchronously*
 * when this content script has been orphaned by an extension reload, so a
 * `.catch()` on the promise is not enough — we must guard the call itself.
 */
function fireAndForget(message: EpisodeMetaMessage | EpisodeWatchedMessage): void {
  if (!isExtensionContextValid()) return;
  try {
    void chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    /* extension context invalidated (reloaded) — ignore */
  }
}

export function sendEpisodeMeta(meta: TrackerMeta): void {
  fireAndForget({ type: 'EPISODE_META', meta });
}

export function sendEpisodeWatched(episodeId: string): void {
  fireAndForget({ type: 'EPISODE_WATCHED', episodeId });
}

export function requestTabStatus(tabId: number): Promise<TabStatusResponse> {
  return chrome.runtime.sendMessage<TabStatusRequest, TabStatusResponse>({
    type: 'GET_TAB_STATUS',
    tabId,
  });
}

export function requestMalStatus(meta: TrackerMeta): Promise<MalStatusResponse> {
  return chrome.runtime.sendMessage<MalStatusRequest, MalStatusResponse>({
    type: 'GET_MAL_STATUS',
    meta,
  });
}

export function setMalStatus(
  meta: TrackerMeta,
  patch: SetMalStatusRequest['patch'],
): Promise<MalStatusResponse> {
  return chrome.runtime.sendMessage<SetMalStatusRequest, MalStatusResponse>({
    type: 'SET_MAL_STATUS',
    meta,
    patch,
  });
}

export function requestMalCharacters(animeId: number): Promise<MalCharactersResponse> {
  return chrome.runtime.sendMessage<MalCharactersRequest, MalCharactersResponse>({
    type: 'GET_MAL_CHARACTERS',
    animeId,
  });
}

export function requestMalReviews(animeId: number): Promise<MalReviewsResponse> {
  return chrome.runtime.sendMessage<MalReviewsRequest, MalReviewsResponse>({
    type: 'GET_MAL_REVIEWS',
    animeId,
  });
}

export function requestMyList(status: string): Promise<MyListResponse> {
  return chrome.runtime.sendMessage<MyListRequest, MyListResponse>({
    type: 'GET_MY_LIST',
    status,
  });
}

export function requestSeasonal(): Promise<SeasonalResponse> {
  return chrome.runtime.sendMessage<SeasonalRequest, SeasonalResponse>({
    type: 'GET_SEASONAL',
  });
}

