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
import {
    Action,
    ActionFlag,
    ActionSource,
    ActionVerb,
    isActionEntryGroup,
    isActionVerb,
    ModAction,
    VERB_SCHEMA,
} from './action';

/**
 * The top-level `Actions [ ... ]` list of a manifest, or undefined. The game looks nodes up
 * case-insensitively (OTGroupNode keys its children with InvariantCultureIgnoreCase), so a
 * published manifest writing `actions [...]` loads fine and must be recognized here too.
 */
export const findActionsList = (document: AbstractNodeDocument): ListNode | undefined =>
    document.elements.find((e): e is ListNode => isListNode(e) && e.identifier?.name.toLowerCase() === 'actions');

/**
 * Whether a document is an included action fragment: it has a top-level `Actions` list holding at
 * least one action entry (a `{}` group with an `Action` field). Such a file (launcher.rules,
 * register.rules) is concatenated into a manifest's `Actions` at load time via
 * `Actions: &<file>/Actions`, so its action targets resolve against the game root exactly like a
 * manifest's and are validated the same way. Callers gate this on the file NOT being a manifest
 * (a manifest is handled through the registrar).
 */
export const isActionFragmentDocument = (document: AbstractNodeDocument): boolean => {
    const list = findActionsList(document);
    return !!list && list.elements.some((element) => isGroupNode(element) && isActionEntryGroup(element));
};

/**
 * An action group's field names mapped to their value node (assignment RHS or identified
 * `{}`/`[]`). Keys are lower-cased to mirror the game's case-insensitive node lookup.
 */
const fieldsOf = (group: GroupNode): Map<string, AbstractNode> => {
    const fields = new Map<string, AbstractNode>();
    for (const [name, node] of namedMembersOf(group)) fields.set(name.toLowerCase(), node);
    return fields;
};

/** Parse a single `{}` Actions entry into a structured {@link ModAction}. */
const parseAction = (group: GroupNode): ModAction => {
    const fields = fieldsOf(group);
    const presentFields = new Set(fields.keys());

    const verbField = fields.get('action');
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
        const node = fields.get(targetField.toLowerCase());
        if (!node) continue;

        if (isListNode(node)) {
            action.targets.push(...node.elements.filter(isValueNode));
        } else if (isValueNode(node)) {
            action.targets.push(node);
        }
    }

    for (const sourceField of schema.sources) {
        const node = fields.get(sourceField.toLowerCase());
        if (node && (isValueNode(node) || isGroupNode(node) || isListNode(node))) {
            action.sources.push(node as ActionSource);
        }
    }

    for (const flag of schema.flags) {
        const node = fields.get(flag.toLowerCase());
        if (node && isValueNode(node) && node.valueType.type === 'Boolean') {
            action.flags[flag as ActionFlag] = node.valueType.value;
        }
    }

    if (schema.named) {
        const nameNode = fields.get(schema.named.toLowerCase());
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
