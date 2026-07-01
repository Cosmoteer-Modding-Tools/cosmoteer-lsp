/**
 * "Did you mean …?" support: pick the candidate string closest to a mistyped one.
 *
 * Used by the diagnostics to turn an unresolved reference name or a missing asset file
 * into an actionable suggestion (and a quick-fix), e.g. `PrhibitedBy` → `ProhibitedBy`.
 */

/**
 * Levenshtein edit distance between two strings (insert/delete/substitute = 1).
 * @param a the first string
 * @param b the second string
 * @returns the minimum number of single-character edits to turn `a` into `b`
 */
export const levenshtein = (a: string, b: string): number => {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // Single rolling row — we only ever need the previous row.
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
        const current = [i + 1];
        for (let j = 0; j < b.length; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            current.push(Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost));
        }
        previous = current;
    }
    return previous[b.length];
};

/**
 * The candidate closest to `target`, or `null` when nothing is close enough to be a
 * plausible typo. "Close enough" scales with the target length (a longer word tolerates
 * more typos) and never matches across more than ~40% of the word, so unrelated names
 * are not suggested.
 * @param target the possibly mistyped string to match
 * @param candidates the pool of valid strings to match against
 * @param caseInsensitive whether to compare without regard to letter case
 * @returns the closest candidate, or `null` when none is within the tolerance
 */
export const closestMatch = (target: string, candidates: Iterable<string>, caseInsensitive = false): string | null => {
    const needle = caseInsensitive ? target.toLowerCase() : target;
    // Allow more edits for longer words, but stay strict for short ones (≤4 chars → 1 edit).
    const maxDistance = Math.max(1, Math.floor(target.length * 0.4));

    let best: string | null = null;
    let bestDistance = Infinity;
    for (const candidate of candidates) {
        if (candidate === target) continue;
        const hay = caseInsensitive ? candidate.toLowerCase() : candidate;
        if (hay === needle) continue;
        const distance = levenshtein(needle, hay);
        if (distance < bestDistance && distance <= maxDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
};
