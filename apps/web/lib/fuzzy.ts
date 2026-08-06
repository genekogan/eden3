/**
 * Tiny scored subsequence matcher for the command palette and other
 * filter-as-you-type UIs. No dependency — the palette needs ranking, not
 * a search engine.
 *
 * Scoring: every query char must appear in order (case-insensitive) or the
 * match is rejected (null). Points favor what humans mean when they type
 * fragments: consecutive runs, word starts ("gs" → "Gateway Settings"),
 * matches near the beginning, and shorter targets.
 */

const WORD_BOUNDARY = /[\s/_\-.:]/;

/** Score `query` against `text`; higher is better, null = no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  if (q.length > t.length) return null;

  let score = 0;
  let ti = 0;
  let prevMatch = -2; // -2 so index 0 never counts as consecutive
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q.charAt(qi);
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    // Base point per matched char.
    score += 1;
    // Consecutive-run bonus.
    if (found === prevMatch + 1) score += 4;
    // Word-start bonus (start of string or after a separator).
    if (found === 0 || WORD_BOUNDARY.test(t.charAt(found - 1))) score += 6;
    // Early-match bonus, tapering off.
    score += Math.max(0, 3 - found * 0.25);
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer tighter targets: small penalty per unmatched char.
  score -= (t.length - q.length) * 0.05;
  return score;
}

export interface FuzzyResult<T> {
  item: T;
  score: number;
}

/** Filter+rank `items` by `query` over `keyOf(item)`; best first. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  keyOf: (item: T) => string,
): FuzzyResult<T>[] {
  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, keyOf(item));
    if (score !== null) results.push({ item, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
