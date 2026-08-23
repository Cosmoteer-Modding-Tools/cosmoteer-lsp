/**
 * A lookup table keyed by text the user wrote, with no inherited members reachable through it.
 *
 * A plain object literal answers `constructor` and `__proto__` from `Object.prototype`, and both
 * survive the `toLowerCase()` every one of these tables applies to the written name. The answer is
 * truthy but carries none of the entry's fields, so a caller that trusts the lookup reads undefined
 * off it and throws, or quietly treats a name the table never held as a hit. Building the table on
 * a null prototype removes that surface instead of asking every lookup to guard itself.
 *
 * `Object.keys`, `Object.entries` and spreading all behave as they do on a plain object, so a table
 * moved onto this helper needs no change at the places that enumerate it.
 *
 * @param entries the table's own entries, written as an ordinary object literal.
 * @returns the same entries on an object with a null prototype.
 */
export const registry = <T>(entries: Record<string, T>): Readonly<Record<string, T>> =>
    Object.assign(Object.create(null) as Record<string, T>, entries);
