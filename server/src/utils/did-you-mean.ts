/**
 * "Did you mean …?" support: pick the candidate string closest to a mistyped one.
 *
 * Used by the diagnostics to turn an unresolved reference name or a missing asset file
 * into an actionable suggestion (and a quick-fix), e.g. `PrhibitedBy` → `ProhibitedBy`.
 *
 * Performance matters here: a whole-workspace scan calls {@link closestMatch} once per broken
 * reference/key against candidate pools of tens of thousands of entries (all localization keys),
 * which unoptimized was over a third of the entire scan's CPU. The search therefore prunes by
 * length before comparing and abandons a distance computation as soon as it exceeds the best
 * bound, which changes no result: pruned candidates could never have won.
 */

/**
 * Levenshtein edit distance between two strings (insert/delete/substitute = 1). With a `limit`,
 * the computation stops as soon as the distance provably exceeds it and returns `limit + 1` —
 * exact distances above the limit are indistinguishable to callers that only accept matches
 * within it.
 * @param a the first string
 * @param b the second string
 * @param limit the largest distance the caller still cares about
 * @returns the edit distance, or `limit + 1` when the distance exceeds `limit`
 */
export const levenshtein = (a: string, b: string, limit = Infinity): number => {
    if (a === b) return 0;
    if (a.length === 0) return b.length > limit ? limit + 1 : b.length;
    if (b.length === 0) return a.length > limit ? limit + 1 : a.length;
    // Deleting/inserting the length difference is unavoidable, so it lower-bounds the distance.
    if (Math.abs(a.length - b.length) > limit) return limit + 1;

    // Single rolling row — we only ever need the previous row.
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
        const current = [i + 1];
        let rowMin = i + 1;
        for (let j = 0; j < b.length; j++) {
            const cost = a[i] === b[j] ? 0 : 1;
            const value = Math.min(current[j] + 1, previous[j + 1] + 1, previous[j] + cost);
            current.push(value);
            if (value < rowMin) rowMin = value;
        }
        // Row values never decrease across rows, so once the whole row exceeds the limit the
        // final distance must too.
        if (rowMin > limit) return limit + 1;
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
        // A new winner must beat the current best strictly, so the effective bound shrinks as
        // matches improve. At bound 0 nothing can win (distance 0 means equality, skipped below).
        const bound = Math.min(maxDistance, bestDistance - 1);
        if (bound < 1) break;
        if (Math.abs(candidate.length - needle.length) > bound) continue;
        if (candidate === target) continue;
        const hay = caseInsensitive ? candidate.toLowerCase() : candidate;
        if (hay === needle) continue;
        const distance = levenshtein(needle, hay, bound);
        if (distance < bestDistance && distance <= bound) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
};
