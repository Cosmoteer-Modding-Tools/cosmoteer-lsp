import { AbstractNodeDocument, ListNode } from '../../../core/ast/ast';
import { findActionsList } from '../../../mod/action-parser';
import { namedMembersOf } from '../../../utils/ast.utils';
import { relativeRulesReference } from '../shared-base/base-file.emitter';

/**
 * Emits the `AddMany` entry a mod writes to put a part into a vanilla ship's `Parts` list, and finds
 * where that entry goes in the manifest. The shape is the game's own, as
 * `Standard Mods/example_mod/mod.rules` teaches it: an `AddTo` naming the list against the game root
 * and a `ManyToAdd` list of `&` references resolved against the manifest's own directory.
 */

/** The manifest member action entries live in, matched case-insensitively like the game's lookup. */
const ACTIONS_MEMBER = 'actions';

/** The indentation a manifest's own `Actions` entries carry when there is none to copy. */
const DEFAULT_INDENT = '\t';

/** Where a new action entry goes in a manifest, and what is written around it. */
type ManifestInsert =
    | {
          /** `append` puts the entry in the existing `Actions` list, `createList` writes a fresh one. */
          readonly kind: 'append' | 'createList';
          /** The byte offset the whole insertion starts at. */
          readonly offset: number;
          /** The text written before the entry. */
          readonly before: string;
          /** The text written after it. */
          readonly after: string;
          /** The indentation every line of the entry carries. */
          readonly indent: string;
      }
    | {
          /** The manifest writes `Actions` as something a new entry cannot be appended to. */
          readonly kind: 'unusable';
      };

/**
 * The game-root path of a ship's `Parts` list, the form an action target takes: read from the game's
 * own `Data` root rather than from the manifest, so it is expressed relative to that root.
 *
 * @param dataRoot the game's `Data` directory.
 * @param shipFsPath the ship file's on-disk path.
 * @param groupName the ship group's name inside it.
 * @returns the target path, with forward slashes on every platform.
 */
export const shipPartsTargetPath = (dataRoot: string, shipFsPath: string, groupName: string): string =>
    relativeRulesReference(dataRoot, shipFsPath, `${groupName}/Parts`);

/**
 * One `AddMany` action entry, adding a single reference to a list.
 *
 * `CreateIfNotExisting` and `IgnoreIfNotExisting` are left out: both default to false, which is what
 * this action wants, and a target the ship does not have is a mistake worth an error rather than a
 * silent no-op.
 *
 * @param target the game-root path of the list the reference is added to.
 * @param sourceRef the reference to add, sigil included, resolved against the manifest's directory.
 * @param indent the indentation the entry's own lines carry.
 * @param lineEnding the ending the manifest already uses, so the entry matches it.
 * @returns the entry's text, with no trailing line ending.
 */
export const addManyActionText = (
    target: string,
    sourceRef: string,
    indent: string,
    lineEnding: '\n' | '\r\n' = '\n'
): string =>
    [
        `${indent}{`,
        `${indent}\tAction = AddMany`,
        `${indent}\tAddTo = "${target}"`,
        `${indent}\tManyToAdd [ ${sourceRef} ]`,
        `${indent}}`,
    ].join(lineEnding);

/** The whitespace the line holding an offset begins with. */
const indentOfLineAt = (text: string, offset: number): string => {
    let start = offset;
    while (start > 0 && text[start - 1] !== '\n') start--;
    let end = start;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    return text.slice(start, end);
};

/** The byte offset of a list's opening bracket, or -1 when the text does not hold one. */
const openerOffset = (text: string, list: ListNode): number => {
    if (text[list.position.start] === '[') return list.position.start;
    const from = list.identifier ? list.identifier.position.end : list.position.start;
    return text.indexOf('[', from);
};

/** The byte offset of a list's closing bracket, or -1 when the span is not as recorded. */
const closerOffset = (text: string, list: ListNode): number =>
    text[list.position.end - 1] === ']' ? list.position.end - 1 : -1;

/**
 * A written `Actions` member head, whatever follows it. The source is checked as well as the tree
 * because the parser drops an `Actions : &<launcher.rules>/Actions` head that carries no body of its
 * own, so the one shape this refusal exists for is the one the tree cannot show.
 */
const ACTIONS_HEAD = /^[ \t]*actions[ \t]*[:=]/im;

/** Whether the manifest declares an `Actions` member at all, whatever shape it has. */
const declaresActions = (text: string, document: AbstractNodeDocument): boolean =>
    namedMembersOf(document).some(([name]) => name.toLowerCase() === ACTIONS_MEMBER) || ACTIONS_HEAD.test(text);

/**
 * Where a new action entry goes: appended to the manifest's own `Actions [ … ]`, or into a fresh
 * top-level `Actions` list written at the end of the file when it declares none.
 *
 * A manifest whose `Actions` is not an appendable list (an included fragment pulled in as
 * `Actions : &<launcher.rules>/Actions`) is reported as unusable rather than given a second `Actions`,
 * which the game would read as a duplicate member.
 *
 * @param text the manifest's source text.
 * @param document that text, parsed.
 * @param lineEnding the ending the manifest already uses.
 * @returns where the entry goes and what is written around it, or that nothing can be written.
 */
export const manifestActionInsert = (
    text: string,
    document: AbstractNodeDocument,
    lineEnding: '\n' | '\r\n' = '\n'
): ManifestInsert => {
    const list = findActionsList(document);
    if (!list) {
        if (declaresActions(text, document)) return { kind: 'unusable' };
        // A blank line separates the new list from whatever the manifest already ends with.
        const gap = text.length === 0 || /\n[ \t]*$/.test(text) ? '' : lineEnding;
        return {
            kind: 'createList',
            offset: text.length,
            before: `${gap}${lineEnding}Actions${lineEnding}[${lineEnding}`,
            after: `${lineEnding}]${lineEnding}`,
            indent: DEFAULT_INDENT,
        };
    }
    const open = openerOffset(text, list);
    const close = closerOffset(text, list);
    if (open < 0 || close < 0 || close < open) return { kind: 'unusable' };

    const last = list.elements[list.elements.length - 1];
    if (!last) {
        return { kind: 'append', offset: open + 1, before: lineEnding, after: '', indent: DEFAULT_INDENT };
    }
    // Replicate the last entry's own leading whitespace so a manifest written with spaces stays
    // written with spaces, exactly as the grid editor's list append does.
    const lineStart = text.lastIndexOf('\n', last.position.start) + 1;
    const prefix = text.slice(lineStart, last.position.start);
    const indent = /^[ \t]*$/.test(prefix) ? prefix : indentOfLineAt(text, open) + DEFAULT_INDENT;
    return { kind: 'append', offset: last.position.end, before: lineEnding, after: '', indent };
};
