/**
 * How often the game's own files write each field of each class, and the completion ranking built
 * on it.
 *
 * A field-name list sorted required-first and then alphabetically puts `AIFirepowerRating` in front
 * of `MaxHealth`, which is the wrong way round for everyone who has ever written a part. The table
 * in `field-usage.json` counts the shipped data (see `tools/fieldstats/fieldstats.ts`) and turns
 * that into a rank, so the fields an author reaches for come first inside each of the two buckets
 * the list already has.
 *
 * Only the completion list reads this. No validator may: a count is a statistic, and a check that
 * decided anything on one would be guessing rather than reading the game. Keeping it here also
 * keeps it out of the cache build id, so regenerating the table after a game update does not
 * discard every user's on-disk caches.
 *
 * A field the count has never seen falls back to the bottom rank, which leaves it exactly where
 * alphabetical order had it, behind the fields the game writes.
 */
import usage from './field-usage.json';

/** class FullName → field name → how many times the game's own files write it. */
export type FieldUsage = Record<string, Record<string, number>>;

/** How many rank buckets a class's fields are spread over. Two digits keep the sort key short. */
const RANK_DIGITS = 2;

/** The rank a field with no count gets, which sorts after every counted one. */
const UNRANKED = '99';

/** class FullName → field name (folded) → its rank string, built on first use per class. */
const rankCache = new Map<string, Map<string, string>>();

/**
 * The ranks of one class's fields, most written first. Ranks are positions rather than counts, so
 * the key stays short and a field written twice as often as another is simply in front of it.
 *
 * @param cls the class FullName.
 * @returns the folded field name to its two-digit rank.
 */
const ranksFor = (cls: string): Map<string, string> => {
    const cached = rankCache.get(cls);
    if (cached) return cached;
    const ranks = new Map<string, string>();
    const counted = (usage as FieldUsage)[cls];
    if (counted) {
        // The table is already written most-written-first, so the position in it is the rank.
        let position = 0;
        for (const name of Object.keys(counted)) {
            const rank = Math.min(position, 10 ** RANK_DIGITS - 2);
            ranks.set(name.toLowerCase(), String(rank).padStart(RANK_DIGITS, '0'));
            position++;
        }
    }
    rankCache.set(cls, ranks);
    return ranks;
};

/**
 * The sort rank of a field on a class, for the completion list's sort key.
 *
 * @param cls the class the field is offered on, or undefined when the group's class is unknown.
 * @param field the field name as the schema spells it.
 * @returns the rank string, or the unranked bucket when nothing counted the field.
 */
export const fieldUsageRank = (cls: string | undefined, field: string): string =>
    (cls ? ranksFor(cls).get(field.toLowerCase()) : undefined) ?? UNRANKED;
