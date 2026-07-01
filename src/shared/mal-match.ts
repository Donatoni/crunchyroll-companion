/**
 * Pure title-matching logic for resolving a Crunchyroll series+season to the
 * right MyAnimeList entry. Extracted from the service worker so it can be unit
 * tested — the resolver has real regression risk (spin-offs, season splits).
 */

/** Normalize a title for fuzzy comparison (lowercase, alphanumerics only). */
export function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Best-effort season number a (normalized) title refers to. Defaults to 1.
 * `baseName` is the series name we're matching against, so a number that's part
 * of the name itself (e.g. "Mob Psycho 100") isn't mistaken for a season.
 */
export function detectSeason(normalizedTitle: string, baseName: string): number {
  const t = normalizedTitle;
  let m = t.match(/\bseason\s+(\d+)\b/) ?? t.match(/\b(\d+)(?:st|nd|rd|th)\s+season\b/);
  if (m) return Number(m[1]);
  if (/\bfinal\s+season\b/.test(t)) return 99;
  if (/\biv\b/.test(t)) return 4;
  if (/\biii\b/.test(t)) return 3;
  if (/\bii\b/.test(t)) return 2;
  // A trailing small number ("… 2") reads as a season, unless it's part of the
  // base name itself.
  m = t.match(/\b(\d{1,2})\s*$/);
  if (m && !normalizeTitle(baseName).includes(m[1])) {
    const n = Number(m[1]);
    if (n >= 2 && n <= 20) return n;
  }
  return 1;
}

/** Plain title-similarity score (0–100), no season logic. */
export function titleSimilarity(q: string, t: string): number {
  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.startsWith(q) || q.startsWith(t)) return 80;
  if (t.includes(q) || q.includes(t)) return 55;
  const qWords = new Set(q.split(' '));
  const tWords = t.split(' ');
  const overlap = tWords.filter((w) => qWords.has(w)).length;
  return (overlap / Math.max(qWords.size, tWords.length)) * 50;
}

/**
 * Score how well a MAL anime matches the Crunchyroll series + season. Higher is
 * better.
 *  - Title exactness stops "Black Clover" from resolving to the chibi short
 *    "Mugyutto! Black Clover" (which merely *contains* the name).
 *  - Season alignment stops "Fire Force" (season 2 on CR) from snapping to the
 *    season-1 entry, which matches the franchise name exactly.
 *  - Full TV series are preferred over shorts/specials/spin-offs.
 */
export function matchScore(
  seriesName: string,
  season: number | null,
  anime: { title: string; altTitles: string[]; mediaType: string | null },
): number {
  const q = normalizeTitle(seriesName);
  if (!q) return 0;
  const target = season && season > 0 ? season : 1;

  let bestTitle = 0;
  let candSeason = 1;
  for (const candidate of [anime.title, ...anime.altTitles]) {
    const t = normalizeTitle(candidate);
    const s = titleSimilarity(q, t);
    if (s > bestTitle) {
      bestTitle = s;
      candSeason = detectSeason(t, seriesName);
    }
  }

  let score = bestTitle;
  if (anime.mediaType === 'tv') score += 6;
  score += candSeason === target ? 14 : -22; // season match bonus / mismatch penalty
  return score;
}
