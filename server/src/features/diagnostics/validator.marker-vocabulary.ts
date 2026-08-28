import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../core/ast/ast';
import { markerUsagesOf } from '../../document/schema/category-usage';
import { MarkerVocabulary, SchemaIdIndex } from '../completion/schema-id.index';
import { didYouMeanFix, ValidationError } from './validator';

/**
 * Whether two names differ by a shape a typing slip makes rather than by the shape a deliberate
 * variant makes. A category vocabulary has no declaration to check a name against, so the only
 * separation available is the edit itself, and the two idioms really do differ:
 *  - one substituted letter that is not the trailing one (`laser` and `lazer`), while a trailing
 *    substitution and a swapped digit are both how a variant is named (`carrier2` beside
 *    `carrier3`, `dpm1missile` beside `dpmmmissile`).
 *  - two adjacent characters swapped.
 *  - one letter inserted or dropped inside the word, where the letter neither repeats a neighbour
 *    nor sits against an underscore. A digit or a token pushed in at a word boundary is a variant
 *    (`bounty2tag`, `bountycvtag`), a letter dropped mid-word is a slip.
 *
 * @param a one folded name.
 * @param b the other folded name.
 * @returns true when the difference reads as a slip.
 */
export const isTypoShape = (a: string, b: string): boolean => {
    if (a.length === b.length) {
        const differing: number[] = [];
        for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) differing.push(index);
        if (differing.length === 1) {
            const at = differing[0];
            // A digit swapped anywhere is how a family of variants is numbered, not a slip.
            return at !== a.length - 1 && !/[0-9]/.test(a[at]) && !/[0-9]/.test(b[at]);
        }
        if (differing.length === 2 && differing[1] === differing[0] + 1) {
            return a[differing[0]] === b[differing[1]] && a[differing[1]] === b[differing[0]];
        }
        return false;
    }
    const [short, long] = a.length < b.length ? [a, b] : [b, a];
    if (long.length - short.length !== 1) return false;
    let index = 0;
    while (index < short.length && short[index] === long[index]) index++;
    if (short.slice(index) !== long.slice(index + 1)) return false;
    const extra = long[index];
    if (!/[a-z]/.test(extra)) return false;
    if (long[index - 1] === extra || long[index + 1] === extra) return false;
    if (long[index - 1] === '_' || long[index + 1] === '_') return false;
    return index > 0 && index < long.length - 1;
};

/**
 * How often the rest of the project writes a name, meaning the project total minus what this
 * document contributes. The index counts the document's own saved text too, so a name only this
 * file writes would otherwise look like a name the project agreed on.
 *
 * @param vocabulary the project's marker vocabulary.
 * @param own how often this document writes each name, keyed by class and folded name.
 * @param cls the marker class.
 * @param folded the folded name.
 * @returns the number of usages outside this document, never below zero.
 */
const usesElsewhere = (
    vocabulary: MarkerVocabulary,
    own: Map<string, number>,
    cls: string,
    folded: string
): number => Math.max(0, (vocabulary.get(cls)?.get(folded)?.uses ?? 0) - (own.get(`${cls}|${folded}`) ?? 0));

/**
 * The names of a marker class the project has agreed on, meaning more than one usage outside this
 * document writes them. A name one usage writes cannot vouch for another, since a typo written
 * once would then suggest itself.
 *
 * @param vocabulary the project's marker vocabulary.
 * @param own how often this document writes each name.
 * @param cls the marker class to read.
 * @returns the folded names the rest of the project writes more than once.
 */
const establishedNames = (vocabulary: MarkerVocabulary, own: Map<string, number>, cls: string): string[] => {
    const names: string[] = [];
    for (const folded of vocabulary.get(cls)?.keys() ?? []) {
        if (usesElsewhere(vocabulary, own, cls, folded) > 1) names.push(folded);
    }
    return names;
};

/**
 * Hints at a marker-class name written once in the whole project that is one slip away from a name
 * the project writes everywhere. These vocabularies are defined by their usage: a part category, a
 * part feature or a ship tag exists because some file names it, so nothing rejects a misspelled
 * one. It quietly declares a category of its own instead, and the list that was meant to read it
 * never matches.
 *
 * Deliberately narrow, since a variant of an existing name is a mainstream idiom: only a name no
 * other usage in the project repeats is judged, only against names several usages back, and only
 * when the difference between them has the shape of a slip rather than of a variant.
 *
 * @param document the parsed document to validate.
 * @param folderPaths the project folders the vocabulary is read from.
 * @param cancellationToken cancels the index build and the walk.
 * @returns one hint per name that reads as a misspelling, carrying the name it is one slip from.
 */
export const validateMarkerVocabulary = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const usages = [...markerUsagesOf(document)];
    if (usages.length === 0) return [];
    const vocabulary = await SchemaIdIndex.instance.markerVocabulary(folderPaths, cancellationToken);
    if (cancellationToken.isCancellationRequested) return [];

    const own = new Map<string, number>();
    for (const usage of usages) {
        const key = `${usage.cls}|${usage.id.toLowerCase()}`;
        own.set(key, (own.get(key) ?? 0) + 1);
    }

    const errors: ValidationError[] = [];
    const pools = new Map<string, string[]>();
    const reported = new Set<string>();
    for (const usage of usages) {
        if (cancellationToken.isCancellationRequested) return errors;
        const folded = usage.id.toLowerCase();
        // A name written somewhere outside this document is a word the project uses, whatever it
        // looks like. Only a name this file alone carries is judged.
        if (usesElsewhere(vocabulary, own, usage.cls, folded) > 0) continue;
        const pool =
            pools.get(usage.cls) ?? pools.set(usage.cls, establishedNames(vocabulary, own, usage.cls)).get(usage.cls)!;
        const match = pool.find((name) => isTypoShape(folded, name));
        if (!match) continue;
        const key = `${usage.cls}|${folded}`;
        if (reported.has(key)) continue;
        reported.add(key);
        const suggestion = vocabulary.get(usage.cls)?.get(match)?.written ?? match;
        errors.push({
            message: l10n.t(
                "'{0}' is written nowhere else in the project and is one slip from '{1}', which several files write. A {2} exists because a file names it, so a misspelled one declares a name of its own.",
                usage.id,
                suggestion,
                usage.cls.split('.').pop() ?? usage.cls
            ),
            node: usage.node,
            severity: 'hint',
            ...didYouMeanFix(suggestion),
        });
    }
    return errors;
};
