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

function fromJsonLd(): Partial<TrackerMeta> | null {
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
        };
      }
    } catch {
      /* not valid JSON-LD */
    }
  }
  return null;
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

export function extractMeta(episodeId: string): TrackerMeta | null {
  const ld = fromJsonLd();
  const ids = fromTestIds();
  const series = ld?.series || ids.series || '';
  if (!series) return null;
  return {
    episodeId,
    series,
    season: ld?.season ?? ids.season ?? null,
    episode: ld?.episode ?? ids.episode ?? null,
    episodeTitle: ld?.episodeTitle || ids.episodeTitle || '',
    thumbnail: ld?.thumbnail || ogImage(),
  };
}
