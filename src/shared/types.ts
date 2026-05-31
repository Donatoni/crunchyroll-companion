/** The kinds of segments Crunchyroll marks as skippable. */
export type SkipType = 'intro' | 'recap' | 'credits' | 'preview';

export const SKIP_TYPES: SkipType[] = ['intro', 'recap', 'credits', 'preview'];

/** Human labels used in UI and toasts. */
export const SKIP_LABELS: Record<SkipType, string> = {
  intro: 'Intro',
  recap: 'Recap',
  credits: 'Outro',
  preview: 'Preview',
};

/** A normalized skippable segment with start/end in seconds. */
export interface SkipSegment {
  type: SkipType;
  start: number;
  end: number;
}

/** Everything we know about the episode currently playing. */
export interface EpisodeContext {
  /** Crunchyroll episode id parsed from the /watch/{id}/ URL. */
  episodeId: string;
  url: string;
}

/** Episode metadata for tracker sync, scraped from the watch page. */
export interface TrackerMeta {
  /** Crunchyroll episode id (from the URL). */
  episodeId: string;
  /** Parent series name, e.g. "Classroom of the Elite". */
  series: string;
  /** Season number if known (1-based), else null. */
  season: number | null;
  /** Episode number within the season if known, else null. */
  episode: number | null;
  /** This episode's own title, e.g. "The Flying Classroom". */
  episodeTitle: string;
  /** Episode thumbnail URL, if found on the page. */
  thumbnail: string;
}
