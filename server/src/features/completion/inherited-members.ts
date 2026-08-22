import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AssignmentNode,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { basenameOf } from '../../document/document-kind';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { SchemaField } from '../../document/schema/schema.types';
import { MemberOrigin, flattenGroup } from '../../semantics/effective-group';
import { inheritanceEntriesOf, memberValueOf } from '../../semantics/reference-resolver';
import { Completion } from './autocompletion.service';

/**
 * What a group's inheritance chain already supplies, for the field-name popup.
 *
 * A group that names a base starts out holding every member that base writes: the game reads the
 * union of the chain, with the deriving level's declarations shadowing the ones above it. The
 * field-name popup did not know that. It built its "already written" set from the group's own
 * members alone, so a part inheriting `base_part.rules` was offered `Density` as though nothing set
 * it, and accepting that offer wrote an override that changes nothing. The redundant-override hint
 * then faded the very line the popup had just handed over, which is a loop that teaches the mistake
 * and corrects it in the same breath.
 *
 * This reads the chain once per popup and answers what each name is already worth, so a field the
 * base supplies is offered with the value and the file it comes from, and sorted under the fields
 * that really are unset. It never takes such a field off the list, because writing a new value over
 * an inherited one is the normal way to derive a part.
 *
 * Two things it holds back. A chain with a base the editor could not follow says nothing at all,
 * since half a chain presented as the whole answer would claim a provenance the editor cannot back.
 * And a `~` base is trusted only inside the file that writes it: `~` is the root of wherever the rule
 * is instantiated, so a library group inherited into a part reaches that part's members through it
 * rather than its own file's, and only a member the writing file declares itself is a member this
 * editor can point at. That keeps the shape the game's own data leans on, a top-level `: ~` element
 * of a database file and a part reaching its own `~/OVERCLOCK` block, while a `~` path that leaves
 * the file it is written in stays unspoken for.
 */

/** What one member name is already worth, as it should be shown. */
export interface InheritedMember {
    /** The value the chain supplies, rendered for display. Empty when it has no one-line spelling. */
    readonly value: string;
    /** The file the winning declaration lives in, as the uri or path that file was parsed under. */
    readonly uri: string;
    /** Its line in that file, counted the way the editor's gutter counts. */
    readonly line: number;
}

/** The member names a chain supplies, keyed by lower-cased name, because the game matches member
 *  names without regard to case. */
export type InheritedMembers = ReadonlyMap<string, InheritedMember>;

/** The answer for a group that inherits nothing, and for every chain this module will not speak for. */
export const NO_INHERITED_MEMBERS: InheritedMembers = new Map<string, InheritedMember>();

/** How many characters of a written value the popup shows before it is cut. */
const VALUE_WIDTH = 60;

/**
 * What the bases of a group already supply for it.
 *
 * @param group the group the cursor is in.
 * @param cancellationToken cancels the cross-file walk of the chain.
 * @returns one entry per member name the chain supplies, empty when the chain must not be spoken for.
 */
export const inheritedMembersFor = async (
    group: GroupNode,
    cancellationToken: CancellationToken
): Promise<InheritedMembers> => {
    // The gate that keeps this off the hot path: a group naming no base has nothing to answer, and
    // most groups name none. `inheritanceEntriesOf` also covers the bases a mod's `AddBase` appends,
    // so a group whose chain exists only through a manifest action is not missed here.
    if (inheritanceEntriesOf(group).length === 0) return NO_INHERITED_MEMBERS;
    if (cancellationToken.isCancellationRequested) return NO_INHERITED_MEMBERS;

    const flattened = await flattenGroup(group, cancellationToken).catch(() => undefined);
    if (!flattened || !flattened.complete) return NO_INHERITED_MEMBERS;
    const runTimeRooted = runTimeRootedFiles(group, flattened.bases);

    const supplied = new Map<string, InheritedMember>();
    for (const member of flattened.members) {
        const key = member.name.toLowerCase();
        // The walk yields the nearest base first, which is the declaration the game reads.
        if (supplied.has(key)) continue;
        if (member.origin.inherited) {
            if (runTimeRooted.size > 0 && !runTimeRooted.has(member.origin.uri)) continue;
            supplied.set(key, describe(member.value, member.origin));
            continue;
        }
        // The name is written in this group as well. That is the state of the field the user is
        // still typing, which the popup deliberately keeps offering, so the base's declaration is
        // read back from under the local one rather than left unmentioned.
        const shadowed = member.shadows.find((origin) => origin.inherited);
        if (!shadowed) continue;
        if (runTimeRooted.size > 0 && !runTimeRooted.has(shadowed.uri)) continue;
        supplied.set(key, describe(valueAt(shadowed), shadowed));
    }
    return supplied;
};

/**
 * Whether a schema field is one the chain already supplies, under its own name or one of the
 * spellings the game also binds it from. Decided the same way the required-field check decides a
 * field is satisfied, so the popup and that check agree on what is still missing.
 *
 * @param field the schema field.
 * @param inherited what the chain supplies.
 * @returns true when the game already reads a value for this field here.
 */
export const suppliedByChain = (field: SchemaField, inherited: InheritedMembers): boolean =>
    inherited.has(field.name.toLowerCase()) ||
    (field.aliases?.some((alias) => inherited.has(alias.toLowerCase())) ?? false);

/**
 * Marks every completion whose name the chain already supplies: what the base writes and where, and
 * a sort key that puts it under the fields nothing has set yet. Runs over the finished list so the
 * `Type` discriminator and a material's shader constants are covered along with the schema fields.
 *
 * @param completions the completions the field-name path produced.
 * @param inherited what the chain supplies.
 * @returns the completions, with the inherited ones marked.
 */
export const annotateInheritedMembers = (completions: Completion[], inherited: InheritedMembers): Completion[] => {
    if (inherited.size === 0) return completions;
    return completions.map((completion) => {
        if (typeof completion === 'string') return completion;
        const supplied = inherited.get(completion.label.toLowerCase());
        if (!supplied) return completion;
        return {
            ...completion,
            detail: [completion.detail, l10n.t('inherited from {0}', basenameOf(supplied.uri))]
                .filter(Boolean)
                .join(' · '),
            documentation: [completion.documentation, suppliedLine(completion.label, supplied)]
                .filter(Boolean)
                .join('\n\n'),
            // Writing the field here overrides the base, which is legal and often meant, so it stays
            // on offer and only moves below the ones that are genuinely unset.
            sortText: `2_${completion.label}`,
        };
    });
};

/**
 * The line the popup shows under a field the chain supplies.
 *
 * @param label the field name as the popup spells it.
 * @param supplied what the chain has for that name.
 * @returns the markdown line.
 */
const suppliedLine = (label: string, supplied: InheritedMember): string => {
    const file = basenameOf(supplied.uri);
    return supplied.value
        ? l10n.t('{0} = {1} in {2}:{3}', label, supplied.value, file, String(supplied.line))
        : l10n.t('inherited from {0}', `${file}:${supplied.line}`);
};

/**
 * The display form of one inherited declaration.
 *
 * @param value the value node the declaration carries.
 * @param origin where that declaration lives.
 * @returns the entry the popup shows.
 */
const describe = (value: AbstractNode | null, origin: MemberOrigin): InheritedMember => ({
    value: valueText(value),
    uri: origin.uri,
    // A group or list is positioned on its opening brace, which sits a line below the name on the
    // brace-on-its-own-line style the game's own data is written in, so the name is the better
    // landmark. AST lines are zero-based, the editor's gutter is not.
    line: declaringLineOf(origin.node) + 1,
});

/**
 * The line a declaration is best pointed at.
 *
 * @param node the declaring node.
 * @returns its zero-based line.
 */
const declaringLineOf = (node: AbstractNode): number =>
    (isGroupNode(node) || isListNode(node)) && node.identifier
        ? node.identifier.position.line
        : node.position.line;

/**
 * A written value on one line.
 *
 * @param node the member's value node.
 * @returns the display text, empty when the value has no honest one-line spelling.
 */
const valueText = (node: AbstractNode | null): string => {
    if (!node || isIdentifierNode(node)) return l10n.t('*(no value)*');
    if (isValueNode(node)) {
        const text = String(node.valueType.value).replace(/`/g, "'");
        return '`' + (text.length > VALUE_WIDTH ? `${text.slice(0, VALUE_WIDTH)}…` : text) + '`';
    }
    if (isListNode(node)) return l10n.t('*list of {0}*', String(node.elements.length));
    if (isGroupNode(node)) return l10n.t('*group of {0}*', String(node.elements.length));
    // A computed value is a tree rather than one written token, and guessing at its source text
    // would put a value in the popup that the file does not contain, so the row names only where the
    // declaration is.
    return '';
};

/**
 * The value node behind an origin.
 *
 * An assignment carries no position of its own, so the chain walk anchors it on the name it assigns,
 * and the value is reachable only from the container that holds both.
 *
 * @param origin the declaration to read.
 * @returns its value node, null for an assignment with no value yet.
 */
const valueAt = (origin: MemberOrigin): AbstractNode | null => {
    const node = origin.node;
    if (isIdentifierNode(node) && node.parent) {
        const assignment = node.parent.elements.find((element) => isAssignmentNode(element) && element.left === node);
        if (assignment) return (assignment as AssignmentNode).right;
    }
    return memberValueOf(node);
};

/**
 * The files of a chain that inherit from a `~` root.
 *
 * `~` is the root of wherever the rule is instantiated, which for a library group inherited into a
 * part is that part rather than the library's own file, so the editor cannot tell from the file
 * alone what such a base supplies. What it can tell is that the file writing the `~` declares its
 * own members where it declares them, so once any hop of a chain writes one, only members those
 * files declare themselves are still worth pointing at. Empty when no hop writes one, and then
 * nothing is held back.
 *
 * @param group the group the popup is in.
 * @param bases every base the walk folded in.
 * @returns the uris of the files that write a `~` base, empty when none does.
 */
const runTimeRootedFiles = (group: GroupNode, bases: readonly MemberOrigin[]): ReadonlySet<string> => {
    const files = new Set<string>();
    if (namesRunTimeRoot(group)) files.add(getStartOfAstNode(group).uri);
    for (const base of bases) {
        if ((isGroupNode(base.node) || isListNode(base.node)) && namesRunTimeRoot(base.node)) files.add(base.uri);
    }
    return files;
};

/**
 * Whether a container writes a base rooted at `~`, with or without the optional leading `&`.
 *
 * @param container the container whose bases to read.
 * @returns true when one of them is `~`-rooted.
 */
const namesRunTimeRoot = (container: GroupNode | ListNode): boolean =>
    inheritanceEntriesOf(container).some((entry) => {
        if (!isValueNode(entry) || entry.valueType.type !== 'Reference') return false;
        const reference = String(entry.valueType.value);
        return (reference.startsWith('&') ? reference.slice(1) : reference).startsWith('~');
    });
