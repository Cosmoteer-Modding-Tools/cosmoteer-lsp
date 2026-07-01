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

/** The first child whose key was already used by an earlier sibling, or undefined if all keys are unique. */
const findDuplicate = (elements: AbstractNode[]): { name: string; at: AbstractNode } | undefined => {
    const seen = new Set<string>();
    for (const element of elements) {
        const key = keyOf(element);
        if (!key) continue;
        if (seen.has(key.name)) return key;
        seen.add(key.name);
    }
    return undefined;
};

const callback = async (node: GroupNode | AbstractNodeDocument) => {
    const duplicate = findDuplicate(node.elements);
    if (!duplicate) return undefined;
    return {
        message: l10n.t('Duplicate field "{0}"', duplicate.name),
        node: duplicate.at,
        additionalInfo: l10n.t('"{0}" is defined more than once in this scope; only the last definition takes effect', duplicate.name),
    };
};

// A `[]` list is positional, not keyed, so duplicate detection only applies to `{}` groups and the
// document root, not to lists.
export const ValidationForGroupDuplicates: Validation<GroupNode> = { type: 'Group', callback };
export const ValidationForDocumentDuplicates: Validation<AbstractNodeDocument> = { type: 'Document', callback };
