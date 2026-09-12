import { CancellationToken, CompletionItemKind, Position, Range } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, ListNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { findEnclosingGroup } from '../../document/schema/schema-context';
import { namedMembersOf } from '../../utils/ast.utils';
import { AddBaseIndex } from '../../mod/add-base.index';
import { Completion } from './autocompletion.service';
import { ReferenceAutoCompletionStrategy } from './strategy/reference.autocompletion-strategy';

/**
 * An inheritance-target header line up to the cursor: `<indent><Name> : <typed>`. The `:` (not `=`)
 * marks a group/list inheritance declaration (`Child : Base`), and the captured tail is the base path
 * typed so far. A `Key = value` assignment has `=`, not `:`, so it never matches.
 */
const INHERITANCE_HEADER = /^\s*([A-Za-z_][\w.]*)\s*:\s*(\S*)$/;

/** The bare-name reference-path prefixes an inheritance base can start with (the `&` is conventionally
 *  omitted after `:`). Offered alongside the caret paths and sibling names. */
const PATH_PREFIXES = ['/', '..', '~', '<', '<./Data/', '&<'];

/** The characters that close a reference-path segment, so the completion of a half-typed segment
 *  replaces that segment and nothing of the path before it. */
const SEGMENT_BOUNDARIES = '&<>/';

const referenceStrategy = new ReferenceAutoCompletionStrategy();

/** The name being declared and the base path typed after the `:`, when the line is a header. */
interface InheritanceHeader {
    declaredName: string;
    typed: string;
}

/**
 * Reads an inheritance header off the line left of the cursor.
 *
 * The caller uses this to decide the position before anything else: a line that declares an
 * inheritance base is never a field-name position and never a `Key = ` value position, so the
 * schema completions must not answer there.
 *
 * @param linePrefix the current line's text up to the cursor.
 * @returns the declared name and the typed base, or undefined when the line is not a header.
 */
export const inheritanceHeaderAt = (linePrefix: string): InheritanceHeader | undefined => {
    const match = INHERITANCE_HEADER.exec(linePrefix);
    return match ? { declaredName: match[1], typed: match[2] } : undefined;
};

/**
 * The range a header completion replaces: the path segment the cursor sits in. The labels are single
 * segments (`Components`, `base.rules>`, `^/0/`), so without this the client measures the range with
 * its own word pattern, which breaks at `.` and `^` and appends the pick to what is already typed.
 *
 * @param position the cursor position.
 * @param typed the base path typed after the `:`.
 * @returns the range the pick replaces.
 */
const segmentRange = (position: Position, typed: string): Range => {
    let start = typed.length;
    while (start > 0 && !SEGMENT_BOUNDARIES.includes(typed[start - 1])) start--;
    return {
        start: { line: position.line, character: Math.max(0, position.character - (typed.length - start)) },
        end: position,
    };
};

/**
 * Completions for the base of a group/list inheritance declaration (`Child : <cursor>`).
 *
 * Covers the whole header, from the empty slot right after the `:` to a path being walked
 * (`Child : ^/0/<cursor>`), and it does so whether or not the body braces exist yet: the parser keeps
 * a body-less header as a named group carrying its bases, so the base path resolves against the
 * enclosing container exactly as it does once the body is written.
 *
 * An empty slot, or a lone `^`, offers the inheriting node's siblings (the `Child : Sibling`
 * extend-a-neighbour idiom, and inside a `Components` map the sibling component ids), a `^/N/` caret
 * path per base of the enclosing container (the `Child : ^/0/Child` extend-own-member idiom) and the
 * reference-path prefixes. A path being walked is handed to the reference completer, which lists the
 * members of whatever the path has reached.
 *
 * @param document the parsed document being edited.
 * @param offset the cursor byte offset.
 * @param linePrefix the current line's text up to the cursor.
 * @param position the cursor position, for the replace range.
 * @param cancellationToken cancels the path walk.
 * @returns the completions, or undefined when the cursor is not at an inheritance header.
 */
export const inheritanceTargetCompletionsAt = async (
    document: AbstractNodeDocument,
    offset: number,
    linePrefix: string,
    position: Position,
    cancellationToken: CancellationToken
): Promise<Completion[] | undefined> => {
    const header = inheritanceHeaderAt(linePrefix);
    if (!header) return undefined;
    const container = containerOf(document, offset, header.declaredName);
    if (!container) return undefined;
    const range = segmentRange(position, header.typed);
    // A path (it carries a separator or opens a file token) is resolved by the reference completer
    // against the container the inheriting member lives in, the same scope the game reads the base
    // in. Everything else is still a bare name, where the siblings and the prefixes are the answer.
    if (isPath(header.typed)) {
        const options = await referenceStrategy
            .completeRawPath(header.typed, container, cancellationToken)
            .catch(() => []);
        return options.map((option) =>
            typeof option === 'string' ? { label: option, kind: CompletionItemKind.Reference, range } : { ...option, range }
        );
    }
    return startCompletions(container, header.declaredName, range);
};

/**
 * Whether the typed base is a path the reference completer must walk rather than a bare name.
 *
 * @param typed the base path typed after the `:`.
 * @returns true when the text carries a path separator or opens a file token.
 */
const isPath = (typed: string): boolean => typed.includes('/') || typed.startsWith('<') || typed.startsWith('&');

/**
 * The completions offered at a base slot that is still a bare name: the siblings, the caret paths and
 * the path prefixes.
 *
 * @param container the container the inheriting member lives in.
 * @param declaredName the name being declared, never offered as its own base.
 * @param range the range a pick replaces.
 * @returns the completions.
 */
const startCompletions = (
    container: GroupNode | ListNode | AbstractNodeDocument,
    declaredName: string,
    range: Range
): Completion[] => {
    const self = declaredName.toLowerCase();
    const out: Completion[] = [];
    // Sibling members of the container (in a Components map these are the sibling component ids).
    for (const [name] of namedMembersOf(container)) {
        if (name.toLowerCase() === self) continue;
        out.push({ label: name, kind: CompletionItemKind.Reference, detail: 'sibling', sortText: `0_${name}`, range });
    }
    // `^/N/` caret paths: `^` selects the container's own inheritance anchor, `/N` its Nth base
    // (its written bases plus any a mod's AddBase action appends).
    const slots = inheritanceSlotCount(container);
    for (let i = 0; i < slots; i++) {
        out.push({
            label: `^/${i}/`,
            kind: CompletionItemKind.Keyword,
            detail: 'inherited base',
            sortText: `1_^${i}`,
            range,
        });
    }
    for (const prefix of PATH_PREFIXES) {
        out.push({
            label: prefix,
            kind: CompletionItemKind.Keyword,
            detail: 'reference path',
            sortText: `2_${prefix}`,
            range,
        });
    }
    return out;
};

/**
 * How many `^/N/` slots a container offers: its own written bases plus the ones a mod's `AddBase`
 * action appends. A document root inherits nothing and has none.
 *
 * @param container the container the caret path resolves against.
 * @returns the slot count.
 */
const inheritanceSlotCount = (container: GroupNode | ListNode | AbstractNodeDocument): number =>
    isGroupNode(container) || isListNode(container)
        ? (container.inheritance?.length ?? 0) + AddBaseIndex.instance.appendedBaseCount(container as AbstractNode)
        : 0;

/**
 * The container the inheriting group belongs to: the parent of the group being declared when that
 * group parsed into its own node, else the enclosing group itself (a half-written `Child : ` leaves
 * the cursor outside the child's own span, so the deepest enclosing group is already the container).
 * A header written at the file's top level has the document itself for a container. Siblings, the
 * caret-path bases and a typed path are all read from it.
 *
 * @param document the parsed document being edited.
 * @param offset the cursor byte offset.
 * @param declaredName the name being declared on the header line.
 * @returns the container, or undefined when the declared group's parent is not one.
 */
const containerOf = (
    document: AbstractNodeDocument,
    offset: number,
    declaredName: string
): GroupNode | ListNode | AbstractNodeDocument | undefined => {
    const enclosing = findEnclosingGroup(document, offset);
    if (!enclosing) return document;
    if (enclosing.identifier?.name?.toLowerCase() === declaredName.toLowerCase()) {
        const parent = enclosing.parent;
        return parent && (isGroupNode(parent) || isListNode(parent)) ? parent : document;
    }
    return enclosing;
};
