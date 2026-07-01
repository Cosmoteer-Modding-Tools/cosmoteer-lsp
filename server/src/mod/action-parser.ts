import {
    AbstractNode,
    AbstractNodeDocument,
    ListNode,
    isListNode,
    isGroupNode,
    isValueNode,
    GroupNode,
    ValueNode,
} from '../core/ast/ast';
import { namedMembersOf } from '../utils/ast.utils';
import { Action, ActionFlag, ActionSource, ActionVerb, isActionVerb, ModAction, VERB_SCHEMA } from './action';

/** The top-level `Actions [ ... ]` list of a manifest, or undefined. */
const findActionsList = (document: AbstractNodeDocument): ListNode | undefined =>
    document.elements.find((e): e is ListNode => isListNode(e) && e.identifier?.name === 'Actions');

/** An action group's field names mapped to their value node (assignment RHS or identified `{}`/`[]`). */
const fieldsOf = (group: GroupNode): Map<string, AbstractNode> => new Map(namedMembersOf(group));

/** Parse a single `{}` Actions entry into a structured {@link ModAction}. */
const parseAction = (group: GroupNode): ModAction => {
    const fields = fieldsOf(group);
    const presentFields = new Set(fields.keys());

    const verbField = fields.get('Action');
    const verbNode = verbField && isValueNode(verbField) ? verbField : undefined;
    const verbText = verbNode ? String(verbNode.valueType.value) : undefined;
    const type: ActionVerb | 'Unknown' = isActionVerb(verbText) ? verbText : 'Unknown';

    const action: ModAction = {
        type,
        group,
        verbNode,
        verbText,
        targets: [],
        sources: [],
        flags: {},
        presentFields,
    };

    if (type === 'Unknown') return action;

    const schema = VERB_SCHEMA[type];

    for (const targetField of schema.targets) {
        const node = fields.get(targetField);
        if (!node) continue;

        if (isListNode(node)) {
            action.targets.push(...node.elements.filter(isValueNode));
        } else if (isValueNode(node)) {
            action.targets.push(node);
        }
    }

    for (const sourceField of schema.sources) {
        const node = fields.get(sourceField);
        if (node && (isValueNode(node) || isGroupNode(node) || isListNode(node))) {
            action.sources.push(node as ActionSource);
        }
    }

    for (const flag of schema.flags) {
        const node = fields.get(flag);
        if (node && isValueNode(node) && node.valueType.type === 'Boolean') {
            action.flags[flag as ActionFlag] = node.valueType.value;
        }
    }

    if (schema.named) {
        const nameNode = fields.get(schema.named);
        if (nameNode && isValueNode(nameNode)) action.nameNode = nameNode as ValueNode;
    }

    return action;
};

/**
 * Parse the `Actions` list of a `mod.rules` manifest into structured {@link Action}s.
 * Returns `[]` when the document has no `Actions` list.
 */
export const parseModActions = (document: AbstractNodeDocument): Action[] => {
    const actions = findActionsList(document);
    if (!actions) return [];
    return actions.elements.filter(isGroupNode).map(parseAction);
};
