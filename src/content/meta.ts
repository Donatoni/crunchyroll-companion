import type { TrackerMeta } from '@/shared/types';

/**
 * Extract episode metadata from the watch page (top frame). Primary source is
 * the page's schema.org JSON-LD (TVEpisode), which carries series name, season
 * and episode number reliably; falls back to the `current-media-*` testid
 * elements Crunchyroll renders.
 */
/** Coerce schema.org image (string | string[] | {url}) into a single URL. */
function coerceImage(img: unknown): string {
  if (typeof img === 'string') return img;
  if (Array.isArray(img)) return coerceImage(img[0]);
  if (img && typeof img === 'object') return String((img as { url?: string }).url ?? '');
  return '';
}

/** JSON-LD episode data, plus the URL it describes (used to detect staleness). */
type JsonLdMeta = Partial<TrackerMeta> & { sourceUrl: string };

function fromJsonLd(): JsonLdMeta | null {
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(el.textContent ?? '');
      if (data?.['@type'] === 'TVEpisode') {
        return {
          series: data.partOfSeries?.name ?? '',
          season: data.partOfSeason?.seasonNumber
            ? Number(data.partOfSeason.seasonNumber)
            : null,
          episode: data.episodeNumber ? Number(data.episodeNumber) : null,
          episodeTitle: data.name ?? '',
          thumbnail: coerceImage(data.image ?? data.thumbnailUrl),
          // The watch URL this block describes. Crunchyroll bakes the JSON-LD at
          // page load and does NOT refresh it on SPA auto-advance, so comparing
          // this against the current episode id tells us if it's gone stale.
          sourceUrl: typeof data.url === 'string' ? data.url : '',
        };
      }
    } catch {
      /* not valid JSON-LD */
    }
  }
  return null;
}

/** Pull "Episode N"/"E N"/"S N"/"Season N" numbers out of a free-text string. */
// Exported for unit tests.
export function parseEpSeason(text: string): { episode: number | null; season: number | null } {
  const ep = text.match(/\bepisode\s*(\d+)/i) ?? text.match(/\bE\s*(\d+)\b/);
  const se = text.match(/\bseason\s*(\d+)/i) ?? text.match(/\bS\s*(\d+)\b/);
  return {
    episode: ep ? Number(ep[1]) : null,
    season: se ? Number(se[1]) : null,
  };
}

/**
 * Episode / season from the `og:title` meta tag, e.g.
 * "Season 1 Part 1 | E2 – The Boys' Promise". Crunchyroll keeps this in sync
 * with the current episode, so it's a reliable fresh source for the number when
 * the JSON-LD is missing or stale (and the `current-media-*` testids are gone).
 */
function fromOgTitle(): { episode: number | null; season: number | null } {
  const og =
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? '';
  return parseEpSeason(og);
}

/** Episode / season parsed from `document.title` (a weaker fallback). */
function fromDocTitle(): { episode: number | null; season: number | null } {
  return parseEpSeason(document.title);
}

function ogImage(): string {
  return (
    document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content ?? ''
  );
}

function textOf(testid: string): string {
  return (
    document.querySelector(`[data-testid="${testid}"]`)?.textContent ?? ''
  ).trim();
}

function fromTestIds(): Partial<TrackerMeta> {
  const epRaw = textOf('current-media-episode-number'); // e.g. "E4" or "S3 E4"
  const epMatch = epRaw.match(/E\s*(\d+)/i);
  const seasonMatch = epRaw.match(/S\s*(\d+)/i);
  return {
    series: textOf('current-media-parent-title'),
    episode: epMatch ? Number(epMatch[1]) : null,
    season: seasonMatch ? Number(seasonMatch[1]) : null,
    episodeTitle: textOf('current-media-title'),
  };
}

const SMALL_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'as', 'by', 'from', 'vs',
]);

// Exported for unit tests.
export function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(' ');
}

/**
 * Episode title from the /watch/{id}/{slug} URL. Crunchyroll slugifies the
 * episode title here, and it's reliable even when the page's JSON-LD/title
 * element only carry the series name.
 */
function fromUrlSlug(): string {
  const m = location.pathname.match(/\/watch\/[^/]+\/([^/?#]+)/);
  return m ? titleCase(m[1]) : '';
}

/**
 * Pick a real episode title. Prefers the page's title element, then the URL
 * slug, then JSON-LD (whose `name` is often just the series name on
 * Crunchyroll); discards any candidate that's just the series name.
 */
function pickEpisodeTitle(
  series: string,
  ...candidates: (string | null | undefined)[]
): string {
  const s = series.trim().toLowerCase();
  for (const c of candidates) {
    const t = (c ?? '').trim();
    if (t && !t.toLowerCase().startsWith(s)) return t;
  }
  return '';
}

export function extractMeta(episodeId: string): TrackerMeta | null {
  const ld = fromJsonLd();
  const ids = fromTestIds();
  const og = fromOgTitle();
  const title = fromDocTitle();

  // Trust the JSON-LD numbers only when they actually describe THIS episode.
  // On SPA auto-advance the JSON-LD keeps the previous episode's data, which is
  // exactly what made the tracker miss the increment (it would re-report the
  // old episode number forever). When its url doesn't reference the current
  // episode id, drop its episode/season and lean on the fresher DOM sources.
  const ldFresh = ld ? !ld.sourceUrl || ld.sourceUrl.includes(episodeId) : false;

  // Series, like the numbers, must be FRESH. The series name only comes from the
  // JSON-LD (the `current-media-*` testids are gone), so a stale block — after an
  // SPA navigation to a *different* show — names the PREVIOUS series. Recording
  // with it is corrupting: history dedups by series, so this episode's URL would
  // be filed under the other show's name, overwriting that entry and making it
  // open the wrong video. When no fresh series source exists yet, return null so
  // `captureEpisode` keeps polling until the page settles on the real one.
  const series = (ldFresh ? ld?.series : '') || ids.series || '';
  if (!series) return null;
  const ldEpisode = ldFresh ? (ld?.episode ?? null) : null;
  const ldSeason = ldFresh ? (ld?.season ?? null) : null;

  return {
    episodeId,
    series,
    // A JSON-LD block whose url matches THIS episode is the authoritative
    // source for the numbers (the `current-media-*` testids no longer exist in
    // the watch DOM). When it's stale (url points at the previous episode after
    // an SPA auto-advance) we drop it and fall back to og:title — which carries
    // an explicit "E<n>" and stays in sync with the current episode — then the
    // testid / page title; `captureEpisode` keeps polling until one is fresh.
    season: ldSeason ?? og.season ?? ids.season ?? title.season ?? null,
    episode: ldEpisode ?? og.episode ?? ids.episode ?? title.episode ?? null,
    episodeTitle: pickEpisodeTitle(
      series,
      ldFresh ? ld?.episodeTitle : '',
      ids.episodeTitle,
      fromUrlSlug(),
    ),
    thumbnail: ld?.thumbnail || ogImage(),
  };
}
