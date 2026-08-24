import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { basenameOf } from '../../document/document-kind';
import { fieldsOf, typeDef } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { SchemaField } from '../../document/schema/schema.types';
import {
    EffectiveMemberEntry,
    MemberOrigin,
    UnreadableBase,
    UnreadableReason,
    flattenGroup,
} from '../../semantics/effective-group';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { navigationDepKey } from '../../utils/navigation-deps';
import { findEnclosingGroup } from '../../document/schema/schema-context';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { valueAt } from '../completion/inherited-members';
import { code, linkDestination, plainPathOf, tableCell } from '../report/markdown-link';

/**
 * The "what the game actually loads here" report: the member set a container really deserializes,
 * after its whole inheritance chain has been folded in.
 *
 * A `.rules` file shows what one level writes. The game reads the union of every base, with the
 * deriving level's declarations shadowing the ones above, and nothing in an editor showed that
 * before: to answer "what is Density on this part" an author had to open each base by hand and stop
 * at the first file that wrote it. This renders the answer with the provenance of every row.
 *
 * Three things it deliberately does not do. It never presents a partial fold as the whole answer:
 * a base that could not be read is listed as such, and the header says the report is incomplete. It
 * never fills a missing value in from a schema default unless the schema records where that default
 * comes from, since an `initializer` default is only trustworthy on a purely reflective type. And it
 * never claims a shadowed declaration is dead weight, only that it is shadowed here, because the
 * same base is usually shared by files this one knows nothing about.
 */

/** How many characters of a written value a row shows before it is cut. */
const VALUE_WIDTH = 60;

/** One table cell's text, escaped the way every markdown report in this server escapes one. */
const cell = tableCell;

/**
 * A markdown link to a node's position, labeled `file.rules:line`. Uses the `vscode://file/…` deep
 * link with a `:line` suffix, since markdown-it rejects the `file:` scheme outright.
 *
 * @param origin the place to link to.
 * @returns the markdown link.
 */
const originLink = (origin: MemberOrigin): string => {
    const line = origin.node.position.line + 1;
    const encoded = linkDestination(plainPathOf(origin.uri));
    return `[${basenameOf(origin.uri)}:${line}](vscode://file/${encoded}:${line})`;
};

/**
 * A written value rendered on one line.
 *
 * @param node the member's value node.
 * @returns the display text.
 */
const valueText = (node: AbstractNode | null): string => {
    if (!node) return l10n.t('*(no value)*');
    if (isValueNode(node)) {
        const text = String(node.valueType.value);
        return code(text.length > VALUE_WIDTH ? `${text.slice(0, VALUE_WIDTH)}…` : text);
    }
    if (isListNode(node)) return l10n.t('*list of {0}*', String(node.elements.length));
    if (isGroupNode(node)) return l10n.t('*group of {0}*', String(node.elements.length));
    return l10n.t('*(unreadable)*');
};

/**
 * The dotted path of a container inside its file, for the report's title.
 *
 * @param node the container.
 * @returns the path, or the file's own name for a document root.
 */
const pathOf = (node: AbstractNode): string => {
    const segments: string[] = [];
    for (let current: AbstractNode | undefined = node; current; current = current.parent) {
        if (isDocumentNode(current)) break;
        if ((isGroupNode(current) || isListNode(current)) && current.identifier) segments.unshift(current.identifier.name);
    }
    return segments.length > 0 ? segments.join('/') : basenameOf(getStartOfAstNode(node).uri);
};

/** The sentence explaining why a base could not be folded in. */
const unreadableText = (reason: UnreadableReason): string => {
    switch (reason) {
        case 'unresolved':
            return l10n.t('the reference resolves to nothing, which stops the game loading this file');
        case 'unresolvable-form':
            return l10n.t('this reference form is resolved only at run time, so the editor cannot follow it');
        case 'wrong-kind':
            return l10n.t('the target is not the same kind of node, which the game refuses outright');
        case 'cycle':
            return l10n.t('the chain comes back to this node, which the game treats as a load failure');
        case 'cancelled':
            return l10n.t('the walk was cancelled before this base was read');
    }
};

/**
 * The rows for members the class declares that no level of the chain writes, with the value the game
 * falls back to.
 *
 * Only a field whose schema records where its default comes from is shown with one: `defaultSource`
 * separates a default read off a constructor or an explicit attribute from one merely inferred from
 * a field initializer, and the latter is only meaningful on a purely reflective type. A field
 * without that provenance is listed as unwritten with no value claimed for it.
 *
 * @param cls the container's resolved class.
 * @param present the member names the fold produced, lowercased.
 * @returns the markdown rows, empty when the class is unknown or fully written.
 */
const defaultRows = (cls: string | undefined, present: ReadonlySet<string>): string[] => {
    if (!cls) return [];
    const rows: string[] = [];
    for (const field of fieldsOf(cls)) {
        if (present.has(field.name.toLowerCase())) continue;
        rows.push(
            `| ${cell(code(field.name))} | ${cell(defaultText(field))} | ${
                field.optional ? l10n.t('schema default') : l10n.t('**required, and written nowhere**')
            } |`
        );
    }
    return rows;
};

/**
 * The value an unwritten field falls back to.
 *
 * @param field the schema field.
 * @returns the display text.
 */
const defaultText = (field: SchemaField): string => {
    if (field.default === undefined || field.default === null) return l10n.t('*unset*');
    return field.defaultSource ? code(String(field.default)) : l10n.t('*{0} (not confirmed)*', String(field.default));
};

/**
 * One member row.
 *
 * @param member the folded member.
 * @returns the markdown row.
 */
const memberRow = (member: EffectiveMemberEntry): string => {
    const where = member.origin.injected
        ? l10n.t('merged in by a mod action, {0}', originLink(member.origin))
        : member.origin.inherited
          ? l10n.t('inherited from {0}', originLink(member.origin))
          : l10n.t('written here, {0}', originLink(member.origin));
    const shadowed =
        member.shadows.length > 0
            ? ` · ${l10n.t('shadows {0}', member.shadows.map(originLink).join(', '))}`
            : '';
    return `| ${cell(code(member.name))} | ${cell(valueText(member.value))} | ${where}${shadowed} |`;
};

/**
 * Whether a file is one of the game's own, so a declaration in it is what the game ships rather than
 * what a mod writes over it.
 *
 * @param uri the file's uri or path, in either of the two shapes the walk produces.
 * @param dataRootKey the canonical key of the game `Data` folder.
 * @returns true when the file sits inside the game's `Data` folder.
 */
const isGameFile = (uri: string, dataRootKey: string): boolean =>
    (navigationDepKey(uri) + '/').startsWith(dataRootKey + '/');

/**
 * The rows naming what this chain loads in place of what the game's own files declare.
 *
 * A member is listed when the game declares it somewhere the chain shadows and the two values are
 * written differently. A value with no one-line spelling, a group, a list or a computed expression,
 * is left out rather than rendered as two identical placeholders: the report would be claiming a
 * comparison it cannot show.
 *
 * @param members the flattened member set.
 * @returns the markdown rows, empty when nothing the game writes is replaced here.
 */
const changedRows = (members: readonly EffectiveMemberEntry[]): string[] => {
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    if (!dataRoot) return [];
    const dataRootKey = navigationDepKey(dataRoot);
    const rows: string[] = [];
    for (const member of members) {
        if (isGameFile(member.origin.uri, dataRootKey)) continue;
        // The nearest declaration of this member the game itself carries, which need not sit at the
        // nearest hop of the chain that does.
        const shadowed = member.shadows.find((origin) => isGameFile(origin.uri, dataRootKey));
        if (!shadowed) continue;
        const theirs = valueAt(shadowed);
        if (!isValueNode(theirs) || !isValueNode(member.value)) continue;
        if (theirs.valueType.value === member.value.valueType.value) continue;
        rows.push(
            `| ${cell(code(member.name))} | ${cell(valueText(theirs))} | ${cell(valueText(member.value))} | ${originLink(
                shadowed
            )} |`
        );
    }
    return rows;
};

/**
 * The container a report is about.
 *
 * @param document the parsed document.
 * @param offset the caret's byte offset.
 * @returns the group under the cursor, or the document root when the caret is outside every group.
 */
const containerAt = (document: AbstractNodeDocument, offset: number): GroupNode | ListNode | AbstractNodeDocument => {
    const group = findEnclosingGroup(document, offset);
    return group && (isGroupNode(group) || isListNode(group)) ? group : document;
};

/**
 * Renders the effective-member report for the container at an offset.
 *
 * @param document the parsed document.
 * @param offset the caret's byte offset.
 * @param token cancels the cross-file fold.
 * @returns the markdown report, or null when the offset sits in nothing readable.
 */
export const generateEffectiveGroupReport = async (
    document: AbstractNodeDocument,
    offset: number,
    token: CancellationToken
): Promise<string | null> => {
    const container = containerAt(document, offset);
    // A list has no member names to fold, so the report is about the group holding it instead.
    const group = isListNode(container) ? nearestGroup(container) : container;
    if (!group) return null;

    const flattened = await flattenGroup(group, token);
    const cls = isDocumentNode(group) ? undefined : resolveGroupClass(group);
    const title = pathOf(group);

    const lines: string[] = [];
    lines.push(`# ${l10n.t('What the game loads for {0}', code(title))}`);
    lines.push('');
    lines.push(l10n.t('In {0}.', originLink({ uri: getStartOfAstNode(group).uri, node: group, hop: 0, inherited: false })));
    if (cls) {
        const def = typeDef(cls);
        lines.push('');
        lines.push(l10n.t('Read by the game as {0}.', code(def?.name ?? cls)));
    }

    lines.push('');
    if (flattened.bases.length === 0) {
        lines.push(l10n.t('This group inherits nothing, so what it writes is all the game reads.'));
    } else {
        lines.push(
            `**${l10n.t('Chain')}** · ` +
                flattened.bases.map((base) => originLink(base)).join(' → ')
        );
    }

    if (!flattened.complete) {
        lines.push('');
        lines.push(
            `> ⚠ ${l10n.t(
                'This report is incomplete. {0} of the chain could not be read, so members those bases supply are missing from the table below.',
                String(flattened.unreadable.length)
            )}`
        );
        for (const base of flattened.unreadable) lines.push(`> - ${unreadableBaseLine(base)}`);
    }

    lines.push('');
    lines.push(`## ${l10n.t('Members the game reads')}`);
    lines.push('');
    lines.push(`| ${l10n.t('Member')} | ${l10n.t('Value')} | ${l10n.t('Where it comes from')} |`);
    lines.push('| --- | --- | --- |');
    if (flattened.members.length === 0) {
        lines.push(`| *${l10n.t('none')}* | | |`);
    } else {
        for (const member of flattened.members) lines.push(memberRow(member));
    }

    const changed = changedRows(flattened.members);
    if (changed.length > 0) {
        lines.push('');
        lines.push(`## ${l10n.t("Changed from the game's own files")}`);
        lines.push('');
        lines.push(
            l10n.t(
                'Members the game declares itself that this chain loads a different value for. A value with no one-line spelling is left out.'
            )
        );
        lines.push('');
        lines.push(
            `| ${l10n.t('Member')} | ${l10n.t('The game writes')} | ${l10n.t('Loaded here')} | ${l10n.t('Where the game writes it')} |`
        );
        lines.push('| --- | --- | --- | --- |');
        lines.push(...changed);
    }

    const present = new Set(flattened.members.map((member) => member.name.toLowerCase()));
    const defaults = defaultRows(cls, present);
    if (defaults.length > 0) {
        lines.push('');
        lines.push(`## ${l10n.t('Members nothing writes')}`);
        lines.push('');
        lines.push(
            l10n.t(
                'Fields of this class no level of the chain declares. A default is shown only where the schema records where it comes from.'
            )
        );
        lines.push('');
        lines.push(`| ${l10n.t('Member')} | ${l10n.t('Falls back to')} | ${l10n.t('Note')} |`);
        lines.push('| --- | --- | --- |');
        lines.push(...defaults);
    }

    return lines.join('\n');
};

/** One line of the incomplete-chain warning. */
const unreadableBaseLine = (base: UnreadableBase): string =>
    `${code(base.reference)}: ${unreadableText(base.reason)}`;

/**
 * The nearest enclosing group of a list, so a caret inside `[ … ]` reports on the group holding it.
 *
 * @param node the list the caret sits in.
 * @returns the group, or null when the list hangs directly off the document root.
 */
const nearestGroup = (node: ListNode): GroupNode | AbstractNodeDocument | null => {
    for (let current: AbstractNode | undefined = node.parent; current; current = current.parent) {
        if (isGroupNode(current) || isDocumentNode(current)) return current;
    }
    return null;
};
