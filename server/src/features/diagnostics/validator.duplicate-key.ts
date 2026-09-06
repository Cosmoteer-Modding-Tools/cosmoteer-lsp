import { AbstractNode, AbstractNodeDocument, GroupNode, isAssignmentNode, isGroupNode, isListNode } from '../../core/ast/ast';
import { Validation } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * The name a child contributes to its enclosing scope, with the node that carries it (so the
 * diagnostic can point at the key itself). Assignments key by their left identifier; an identified
 * `{}`/`[]` keys by its identifier. Anonymous values and positional entries contribute nothing.
 */
const keyOf = (node: AbstractNode): { name: string; at: AbstractNode } | undefined => {
    if (isAssignmentNode(node)) return { name: node.left.name, at: node.left };
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) return { name: node.identifier.name, at: node.identifier };
    return undefined;
};

/**
 * The first child whose key was already used by an earlier sibling, or undefined if all keys are
 * unique. Keys are folded before they are compared, because the game keys a group's children
 * case-insensitively (`OTGroupNode._childrenByName`), so `Damage` and `damage` are one member to it
 * and the second still silently wins.
 *
 * @param elements the children of one keyed scope.
 * @returns the repeated key and the node to point at, or undefined when every key is distinct.
 */
const findDuplicate = (elements: AbstractNode[]): { name: string; at: AbstractNode } | undefined => {
    const seen = new Set<string>();
    for (const element of elements) {
        const key = keyOf(element);
        if (!key) continue;
        const folded = key.name.toLowerCase();
        if (seen.has(folded)) return key;
        seen.add(folded);
    }
    return undefined;
};

/**
 * Reports the first repeated key of one keyed scope. A group registers each child under its name as
 * it reads it and refuses a name it already holds, so a scope carrying the same name twice is a
 * parse failure rather than a silent overwrite, and the file it is in never loads.
 *
 * @param node the group or document root to check.
 * @returns the finding, or undefined when every key in the scope is distinct.
 */
const callback = async (node: GroupNode | AbstractNodeDocument) => {
    const duplicate = findDuplicate(node.elements);
    if (!duplicate) return undefined;
    return {
        message: l10n.t('Duplicate field "{0}"', duplicate.name),
        node: duplicate.at,
        additionalInfo: l10n.t(
            '"{0}" is written more than once in this scope. The game reads names without regard to case and refuses a name a scope already holds, so the whole file fails to load.',
            duplicate.name
        ),
    };
};

// A `[]` list is positional, not keyed, so duplicate detection only applies to `{}` groups and the
// document root, not to lists.
export const ValidationForGroupDuplicates: Validation<GroupNode> = { type: 'Group', callback };
export const ValidationForDocumentDuplicates: Validation<AbstractNodeDocument> = { type: 'Document', callback };
