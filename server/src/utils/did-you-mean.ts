/**
 * "Did you mean …?" support: pick the candidate string closest to a mistyped one.
 *
 * Used by the diagnostics to turn an unresolved reference name or a missing asset file
 * into an actionable suggestion (and a quick-fix), e.g. `PrhibitedBy` → `ProhibitedBy`.
 *
 * Performance matters here: a whole-workspace scan calls {@link closestMatch} once per broken
 * reference/key against candidate pools of tens of thousands of entries (all localization keys),
 * which unoptimized was over a third of the entire scan's CPU. The search therefore prunes by
 * length before comparing, abandons a distance computation as soon as it exceeds the best bound,
 * and restricts the dynamic program to the diagonal band the bound allows, which changes no
 * result: pruned candidates and pruned cells could never have won.
 */

/** Stands in for "unreachable within the band". Small enough that `+ 1` cannot overflow int32. */
const OUT_OF_BAND = 0x3fffffff;

// Scratch rows shared across calls (the server is single-threaded), grown on demand. A fresh pair
// of arrays per candidate was measurable GC churn on whole-workspace scans.
let scratchA = new Int32Array(64);
let scratchB = new Int32Array(64);

/**
 * Levenshtein edit distance between two strings (insert/delete/substitute = 1). With a `limit`,
 * only the diagonal band that can still produce a distance within it is computed, and the
 * computation stops as soon as the distance provably exceeds it and returns `limit + 1`.
 * Exact distances above the limit are indistinguishable to callers that only accept matches
 * within it.
 * @param a the first string
 * @param b the second string
 * @param limit the largest distance the caller still cares about
 * @returns the edit distance, or `limit + 1` when the distance exceeds `limit`
 */
export const levenshtein = (a: string, b: string, limit = Infinity): number => {
    if (a === b) return 0;
    const aLength = a.length;
    const bLength = b.length;
    if (aLength === 0) return bLength > limit ? limit + 1 : bLength;
    if (bLength === 0) return aLength > limit ? limit + 1 : aLength;
    // Deleting/inserting the length difference is unavoidable, so it lower-bounds the distance.
    if (Math.abs(aLength - bLength) > limit) return limit + 1;

    // The band half-width. Any finite value at least the maximum possible distance is equivalent
    // to "unlimited" while keeping the arithmetic below finite.
    const band = limit < aLength + bLength ? limit : aLength + bLength;
    if (scratchA.length < bLength + 2) {
        scratchA = new Int32Array(bLength + 2);
        scratchB = new Int32Array(bLength + 2);
    }
    let previous = scratchA;
    let current = scratchB;
    for (let j = 0; j <= bLength; j++) previous[j] = j > band ? OUT_OF_BAND : j;
    for (let i = 1; i <= aLength; i++) {
        const jStart = i - band > 1 ? i - band : 1;
        const jEnd = i + band < bLength ? i + band : bLength;
        current[0] = i > band ? OUT_OF_BAND : i;
        // Guard the cells adjacent to the band so stale values from two rows ago never leak in.
        if (jStart > 1) current[jStart - 1] = OUT_OF_BAND;
        let rowMin = current[0];
        const charA = a.charCodeAt(i - 1);
        for (let j = jStart; j <= jEnd; j++) {
            let value = previous[j - 1] + (charA === b.charCodeAt(j - 1) ? 0 : 1);
            const deletion = previous[j] + 1;
            if (deletion < value) value = deletion;
            const insertion = current[j - 1] + 1;
            if (insertion < value) value = insertion;
            current[j] = value;
            if (value < rowMin) rowMin = value;
        }
        if (jEnd < bLength) current[jEnd + 1] = OUT_OF_BAND;
        // Row values never decrease across rows, so once the whole row exceeds the limit the
        // final distance must too.
        if (rowMin > band) return limit + 1;
        const swap = previous;
        previous = current;
        current = swap;
    }
    const distance = previous[bLength];
    return distance > limit ? limit + 1 : distance;
};

/**
 * A candidate pool prepared once for many {@link closestMatch} calls: the original spellings and
 * their lowercased counterparts, index-aligned. Saves re-lowercasing tens of thousands of
 * candidates on every query during a whole-workspace scan.
 */
export interface MatchPool {
    readonly originals: readonly string[];
    readonly lowered: readonly string[];
}

/**
 * Prepares a reusable {@link MatchPool} from a candidate collection. Iteration order is preserved,
 * so matching through the pool returns exactly what matching the collection directly would.
 * @param candidates the pool of valid strings to match against
 * @returns the prepared pool
 */
export const buildMatchPool = (candidates: Iterable<string>): MatchPool => {
    const originals = [...candidates];
    return { originals, lowered: originals.map((candidate) => candidate.toLowerCase()) };
};

const isMatchPool = (candidates: Iterable<string> | MatchPool): candidates is MatchPool =>
    'originals' in candidates && 'lowered' in candidates;

/**
 * The candidate closest to `target`, or `null` when nothing is close enough to be a
 * plausible typo. "Close enough" scales with the target length (a longer word tolerates
 * more typos) and never matches across more than ~40% of the word, so unrelated names
 * are not suggested.
 * @param target the possibly mistyped string to match
 * @param candidates the pool of valid strings to match against, or a prepared {@link MatchPool}
 * @param caseInsensitive whether to compare without regard to letter case
 * @returns the closest candidate, or `null` when none is within the tolerance
 */
export const closestMatch = (
    target: string,
    candidates: Iterable<string> | MatchPool,
    caseInsensitive = false
): string | null => {
    const needle = caseInsensitive ? target.toLowerCase() : target;
    // Allow more edits for longer words, but stay strict for short ones (≤4 chars → 1 edit).
    const maxDistance = Math.max(1, Math.floor(target.length * 0.4));

    let best: string | null = null;
    let bestDistance = Infinity;
    // A new winner must beat the current best strictly, so the effective bound shrinks as
    // matches improve. At bound 0 nothing can win (distance 0 means equality, skipped below).
    // Returns false once no candidate can win anymore.
    const consider = (candidate: string, hay: string): boolean => {
        const bound = Math.min(maxDistance, bestDistance - 1);
        if (bound < 1) return false;
        if (Math.abs(candidate.length - needle.length) > bound) return true;
        if (candidate === target || hay === needle) return true;
        const distance = levenshtein(needle, hay, bound);
        if (distance < bestDistance && distance <= bound) {
            best = candidate;
            bestDistance = distance;
        }
        return true;
    };

    if (isMatchPool(candidates)) {
        const { originals, lowered } = candidates;
        for (let i = 0; i < originals.length; i++) {
            if (!consider(originals[i], caseInsensitive ? lowered[i] : originals[i])) break;
        }
    } else {
        for (const candidate of candidates) {
            if (!consider(candidate, caseInsensitive ? candidate.toLowerCase() : candidate)) break;
        }
    }
    return best;
};
