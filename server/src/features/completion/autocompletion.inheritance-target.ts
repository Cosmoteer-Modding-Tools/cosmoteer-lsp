import { CompletionItemKind } from 'vscode-languageserver';
import { AbstractNodeDocument, GroupNode, ListNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { findEnclosingGroup } from '../../document/schema/schema-context';
import { namedMembersOf } from '../../utils/ast.utils';
import { AddBaseIndex } from '../../mod/add-base.index';
import { Completion } from './autocompletion.service';

/**
 * An inheritance-target header line up to the cursor: `<indent><Name> : <typed>`. The `:` (not `=`)
 * marks a group/list inheritance declaration (`Child : Base`), and the captured tail is the base path
 * typed so far. A `Key = value` assignment has `=`, not `:`, so it never matches.
 */
const INHERITANCE_HEADER = /^\s*([A-Za-z_][\w.]*)\s*:\s*(\S*)$/;

/** The bare-name reference-path prefixes an inheritance base can start with (the `&` is conventionally
 *  omitted after `:`). Offered alongside the caret paths and sibling names. */
const PATH_PREFIXES = ['/', '..', '~', '<', '<./Data/'];

/**
 * Completions for the base of a group/list inheritance declaration (`Child : <cursor>`), at a position
 * where the parser has produced no reference value node to complete on yet: the empty slot right after
 * the `:`, or a lone `^` the lexer classifies as a string. Offers the inheriting node's siblings (the
 * `Child : Sibling` extend-a-neighbour idiom, and inside a `Components` map the sibling component ids),
 * a `^/N/` caret path per base of the enclosing container (the `Child : ^/0/Child` extend-own-member
 * idiom), and the reference-path prefixes.
 *
 * Once the user types a `/` (a real path is forming) or any name character (a reference value node now
 * exists), the path-resolving reference completer takes over, so this returns undefined then to avoid
 * duplicating it.
 *
 * @param document the parsed document being edited.
 * @param offset the cursor byte offset.
 * @param linePrefix the current line's text up to the cursor.
 * @returns the inheritance-target completions, or undefined when the cursor is not at such a position.
 */
export const inheritanceTargetCompletions = (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string
): Completion[] | undefined => {
    const match = INHERITANCE_HEADER.exec(linePrefix);
    if (!match) return undefined;
    const [, declaredName, typed] = match;
    // A `/` means a path is being resolved; a bare `^` is the one non-empty case we still serve
    // (it is not a reference value node, so the path completer can't). Any other typed text is a
    // partial name the reference completer already handles from its value node.
    if (typed !== '' && typed !== '^' && !typed.startsWith('^')) return undefined;
    if (typed.includes('/')) return undefined;

    const container = containerOf(document, offset, declaredName);
    if (!container) return undefined;

    const self = declaredName.toLowerCase();
    const out: Completion[] = [];
    // Sibling members of the container (in a Components map these are the sibling component ids).
    for (const [name] of namedMembersOf(container)) {
        if (name.toLowerCase() === self) continue;
        out.push({ label: name, kind: CompletionItemKind.Reference, detail: 'sibling', sortText: `0_${name}` });
    }
    // `^/N/` caret paths: `^` selects the container's own inheritance anchor, `/N` its Nth base
    // (its written bases plus any a mod's AddBase action appends).
    const slots = (container.inheritance?.length ?? 0) + AddBaseIndex.instance.appendedBaseCount(container);
    for (let i = 0; i < slots; i++) {
        out.push({ label: `^/${i}/`, kind: CompletionItemKind.Keyword, detail: 'inherited base', sortText: `1_^${i}` });
    }
    for (const prefix of PATH_PREFIXES) {
        out.push({ label: prefix, kind: CompletionItemKind.Keyword, detail: 'reference path', sortText: `2_${prefix}` });
    }
    return out;
};

/**
 * The container the inheriting group belongs to: the parent of the group being declared when that
 * group parsed into its own node, else the enclosing group itself (an empty `Child : ` can fail to
 * form the child node, so the deepest enclosing group is already the container). Siblings and the
 * caret-path bases are read from it.
 */
const containerOf = (
    document: AbstractNodeDocument,
    offset: number,
    declaredName: string
): GroupNode | ListNode | undefined => {
    const enclosing = findEnclosingGroup(document, offset);
    if (!enclosing) return undefined;
    if (enclosing.identifier?.name?.toLowerCase() === declaredName.toLowerCase()) {
        const parent = enclosing.parent;
        return parent && (isGroupNode(parent) || isListNode(parent)) ? parent : undefined;
    }
    return enclosing;
};
