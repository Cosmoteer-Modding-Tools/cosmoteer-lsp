import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, GroupNode, isGroupNode } from '../../core/ast/ast';
import { basenameOf } from '../../document/document-kind';
import { InheritedMember, inheritedMembersFor } from '../completion/inherited-members';
import { globalSettings } from '../../settings';
import { memberNameAt, namedMembersOf } from '../../utils/ast.utils';

/**
 * Where the declaration under the cursor stands in its group's inheritance chain.
 *
 * A `.rules` file shows one level. A part deriving `base_part.rules` reads the union of the chain,
 * so a field written here may be replacing a value a base already set, and the file gives no sign
 * of it. The effective-group report answers that for a whole container on demand. This answers it
 * for the one line under the cursor, without leaving the file.
 *
 * Two lines can appear. Over a member, what the chain writes for that same name underneath it. Over
 * a group's own name, how much of its member set comes from its bases and how much of that it
 * writes again itself.
 *
 * What it holds back it holds back for the reasons {@link inheritedMembersFor} already establishes:
 * a chain with a base the editor could not follow says nothing, and a `~` base is trusted only
 * inside the file that writes it. The section is therefore silent rather than wrong on a chain the
 * editor cannot stand behind, and it never claims the chain writes a name nowhere, since silence
 * and absence look the same from here.
 */

/** How many base files the chain summary names before the rest are folded into an ellipsis. */
const FILE_WIDTH = 3;

/**
 * The provenance section of a hover.
 *
 * @param node the hovered node.
 * @param documentUri the uri of the document the hover was requested on.
 * @param token cancels the cross-file walk of the chain.
 * @returns the markdown block, or null when the setting is off or nothing can be said.
 */
export const provenanceMarkdown = async (
    node: AbstractNode,
    documentUri: string,
    token: CancellationToken
): Promise<string | null> => {
    if (globalSettings.hover?.showProvenance === false) return null;

    const lines: string[] = [];
    const shadowed = await shadowedLine(node, documentUri, token);
    if (shadowed) lines.push(shadowed);
    // A group's own name is both a member of its parent and a container of its own, so both lines
    // can be true at once: this group replaces one the base writes, and it inherits in its turn.
    if (isGroupNode(node)) {
        const summary = await chainSummary(node, token);
        if (summary) lines.push(summary);
    }
    return lines.length > 0 ? lines.join('\n\n') : null;
};

/**
 * What the chain writes for the hovered member underneath the declaration in this file.
 *
 * @param node the hovered node.
 * @param documentUri the uri of the document the hover was requested on.
 * @param token cancels the cross-file walk of the chain.
 * @returns the markdown line, or null when the name is not shadowed or cannot be spoken for.
 */
const shadowedLine = async (
    node: AbstractNode,
    documentUri: string,
    token: CancellationToken
): Promise<string | null> => {
    const container = node.parent;
    if (!container || !isGroupNode(container)) return null;
    const name = memberNameAt(node, container);
    if (!name) return null;

    const supplied = await inheritedMembersFor(container, token);
    const base = supplied.get(name.toLowerCase());
    if (!base) return null;
    return `↳ ${describeBase(base, documentUri)}`;
};

/**
 * The sentence naming the declaration a member replaces. A base in the hovered file is placed by
 * line alone, anything else names its file too.
 *
 * @param base what the chain supplies for the name.
 * @param documentUri the uri of the document the hover was requested on.
 * @returns the markdown text of the line.
 */
const describeBase = (base: InheritedMember, documentUri: string): string => {
    const line = String(base.line);
    const sameFile = base.uri === documentUri;
    // A computed value has no honest one-line spelling, so that row names only where it is written.
    if (!base.value) {
        return sameFile
            ? l10n.t('Replaces the declaration on line {0}', line)
            : l10n.t('Replaces the declaration in {0}:{1}', basenameOf(base.uri), line);
    }
    return sameFile
        ? l10n.t('Replaces {0} on line {1}', base.value, line)
        : l10n.t('Replaces {0} in {1}:{2}', base.value, basenameOf(base.uri), line);
};

/**
 * How much of a group's member set its bases supply, and how much of that it writes again.
 *
 * @param group the hovered group.
 * @param token cancels the cross-file walk of the chain.
 * @returns the markdown line, or null when the group inherits nothing this editor speaks for.
 */
const chainSummary = async (group: GroupNode, token: CancellationToken): Promise<string | null> => {
    const supplied = await inheritedMembersFor(group, token);
    if (supplied.size === 0) return null;

    const local = localNames(group);
    const rewritten = [...supplied.keys()].filter((name) => local.has(name)).length;
    const files = [...new Set([...supplied.values()].map((base) => basenameOf(base.uri)))];
    const named = files.slice(0, FILE_WIDTH).map((file) => '`' + file + '`');
    if (files.length > named.length) named.push('…');

    const sentences = [l10n.t('Its bases supply {0} fields, from {1}.', String(supplied.size), named.join(', '))];
    if (rewritten > 0) sentences.push(l10n.t('{0} of them are written here as well.', String(rewritten)));
    return sentences.join(' ');
};

/**
 * The member names a group writes itself, lower-cased, because the game matches member names
 * without regard to case.
 *
 * @param group the group to read.
 * @returns its own names.
 */
const localNames = (group: GroupNode): ReadonlySet<string> =>
    new Set(namedMembersOf(group).map(([name]) => name.toLowerCase()));
