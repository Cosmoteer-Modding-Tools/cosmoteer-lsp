import {
    AbstractNode,
    ListNode,
    GroupNode,
    ValueNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../core/ast/ast';

/**
 * Model of the `Actions` entries in a `mod.rules` manifest.
 *
 * A `mod.rules` file patches the base game through a top-level `Actions` list. Each
 * entry is a `{}` group with `Action = <verb>` plus verb-specific fields. The seven
 * verbs (from the cosmoteer `Standard Mods/example_mod/mod.rules`) are modeled below.
 *
 * Target fields name an existing location in the game data (resolved against the game
 * Data root): `AddTo`, `OverrideIn`, `Replace`, `Remove`, `RemoveMany`, `AddBaseTo`.
 * Source fields supply the new data and are resolved relative to the mod root:
 * `ToAdd`, `Overrides`, `ManyToAdd`, `With`, `BaseToAdd`.
 */
export const ACTION_VERBS = ['Add', 'AddMany', 'Overrides', 'Replace', 'Remove', 'RemoveMany', 'AddBase'] as const;
export type ActionVerb = (typeof ACTION_VERBS)[number];

export const isActionVerb = (text: string | undefined): text is ActionVerb =>
    !!text && (ACTION_VERBS as readonly string[]).includes(text);

export type ActionFlag = 'OnlyIfNotExisting' | 'CreateIfNotExisting' | 'IgnoreIfNotExisting';

/**
 * The AST shape a verb's source value is allowed to take (per the modding wiki).
 * `list` must be a `[]` list (AddMany.ToAdd); `group` must be a `{}` group
 * (Overrides.Overrides); `composite` is a `&` reference, `{}` group or `[]` list,
 * but never a plain value (AddBase.BaseToAdd).
 *
 * Verbs that accept any value shape (Add, Replace) leave this undefined.
 */
export type SourceShape = 'list' | 'group' | 'composite';

/**
 * The AST shape the verb's target must resolve to in the game tree (per the modding wiki).
 * `list` must point at a `[]` list node (AddMany.AddTo); `container` must point at a
 * `[]` list or `{}` group node (AddBase.AddBaseTo); `group` must point at a `{}` group
 * node or a whole file (Overrides.OverrideIn), which `ModOverridesAction.ApplyAction`
 * enforces by throwing "must be a {} group node or file" on anything else. A file's top
 * level is a group in the game's own tree, so `allowsWholeFileTarget` covers that half.
 *
 * Verbs that accept any target node (Add, Replace, Remove, …) leave this undefined.
 */
export type TargetShape = 'list' | 'container' | 'group';

/** Per-verb field schema, the single source of truth for parsing, validation and completion. */
interface VerbSchema {
    targets: string[];
    sources: string[];
    flags: ActionFlag[];
    required: string[];
    /** Constraint on the AST shape of the source value, if the verb restricts it. */
    sourceShape?: SourceShape;
    /** Constraint on the AST shape of the resolved target node, if the verb restricts it. */
    targetShape?: TargetShape;
    /**
     * Whether the verb may target a whole `.rules` file (via either a string path or a `&`
     * reference). Only Overrides allows this. A file's top level is itself a group, so
     * Overrides can override its members. Every other verb must target a node inside a file.
     */
    allowsWholeFileTarget?: boolean;
    /** The optional `Name` key (Add only): a key under which `ToAdd` is added, never a target. */
    named?: string;
    /**
     * Optional extra fields the game reads on this verb beyond targets/sources/flags. Currently just
     * `Index` (an int) on Add/AddMany/AddBase, the insertion position: the new child (or, for
     * AddBase, the new inheritance entry) is inserted there instead of appended. Never required.
     */
    optionals?: string[];
}

export const VERB_SCHEMA: Record<ActionVerb, VerbSchema> = {
    Add: {
        targets: ['AddTo'],
        sources: ['ToAdd'],
        flags: ['OnlyIfNotExisting', 'CreateIfNotExisting', 'IgnoreIfNotExisting'],
        required: ['AddTo', 'ToAdd'],
        // `ModAddAction.ApplyAction` throws "must be a file, {} group node, or [] list node" on
        // anything else, and a whole file is one of the three it accepts.
        targetShape: 'container',
        allowsWholeFileTarget: true,
        named: 'Name',
        optionals: ['Index'],
    },
    AddMany: {
        targets: ['AddTo'],
        sources: ['ManyToAdd'],
        flags: ['CreateIfNotExisting', 'IgnoreIfNotExisting'],
        required: ['AddTo', 'ManyToAdd'],
        sourceShape: 'list',
        targetShape: 'list',
        optionals: ['Index'],
    },
    Overrides: {
        targets: ['OverrideIn'],
        sources: ['Overrides'],
        flags: ['CreateIfNotExisting', 'IgnoreIfNotExisting'],
        required: ['OverrideIn', 'Overrides'],
        sourceShape: 'group',
        targetShape: 'group',
        allowsWholeFileTarget: true,
    },
    Replace: {
        targets: ['Replace'],
        sources: ['With'],
        flags: ['IgnoreIfNotExisting'],
        required: ['Replace', 'With'],
    },
    Remove: {
        targets: ['Remove'],
        sources: [],
        flags: ['IgnoreIfNotExisting'],
        required: ['Remove'],
    },
    RemoveMany: {
        targets: ['RemoveMany'],
        sources: [],
        flags: ['IgnoreIfNotExisting'],
        required: ['RemoveMany'],
    },
    AddBase: {
        targets: ['AddBaseTo'],
        sources: ['BaseToAdd'],
        flags: ['IgnoreIfNotExisting'],
        required: ['AddBaseTo', 'BaseToAdd'],
        sourceShape: 'composite',
        targetShape: 'container',
        optionals: ['Index'],
    },
};

/** Every field name that holds a game-data target path (used to skip generic ref validation on them). */
export const TARGET_FIELDS = new Set<string>(Object.values(VERB_SCHEMA).flatMap((s) => s.targets));

const targetFieldKeys = new Set([...TARGET_FIELDS].map((name) => name.toLowerCase()));

/** Whether a written field name is a target field, ignoring case like the game's node lookup. */
export const isTargetField = (name: string): boolean => targetFieldKeys.has(name.toLowerCase());

/** Every boolean flag field name across all verbs. */
export const FLAG_FIELDS = new Set<string>(Object.values(VERB_SCHEMA).flatMap((s) => s.flags));

/** A source supplies new data: a reference value, or an inline group/list. */
export type ActionSource = ValueNode | GroupNode | ListNode;

/**
 * A parsed mod action with its AST nodes captured so diagnostics/completion have
 * positions. `targets` is a flat list of the `<...>` path value nodes (RemoveMany
 * expands its list elements).
 */
export interface ModAction {
    type: ActionVerb | 'Unknown';
    /** The `{}` entry group in the Actions list. */
    group: GroupNode;
    /** The `Action = <verb>` right-hand value node. */
    verbNode?: ValueNode;
    verbText?: string;
    targets: ValueNode[];
    sources: ActionSource[];
    /** The `Name` value node for a named `Add`. */
    nameNode?: ValueNode;
    flags: Partial<Record<ActionFlag, boolean>>;
    /** Lower-cased names of all fields present on the entry (for case-insensitive required-field checks). */
    presentFields: Set<string>;
}

/** Public alias kept stable: the registrar stores `Action[]`. */
export type Action = ModAction;

/** The case-insensitive name of the list that holds action entries, per the game's node lookup. */
const ACTIONS_LIST_NAME = 'actions';

/** Whether a `{}` group directly declares an `Action = …` field (the game's action-entry marker). */
const hasActionField = (group: GroupNode): boolean =>
    group.elements.some(
        (element) =>
            isAssignmentNode(element) && element.left.name.toLowerCase() === 'action' && isValueNode(element.right)
    );

/**
 * Whether a node is a list of mod action entries.
 *
 * A manifest writes its own list as `Actions`, but a manifest can also concatenate fragment lists
 * into it (`Actions : &<ParryList.rules>/ParryList  &<PartOverrides.rules>/PartOverrides`), and
 * those lists carry whatever name their file gave them. The game reads every entry the manifest's
 * `Actions` ends up holding, so a top-level list whose entries declare `Action = …` is an actions
 * list under any name. Requiring the top level keeps a `{ Action = … }` group that happens to sit
 * in some nested gameplay list from being read as a mod action.
 *
 * @param node the node to inspect.
 * @returns true when the node is a list the game reads action entries from.
 */
export const isActionsList = (node: AbstractNode | undefined): node is ListNode => {
    if (!node || !isListNode(node)) return false;
    if (node.identifier?.name.toLowerCase() === ACTIONS_LIST_NAME) return true;
    return (
        !!node.parent &&
        isDocumentNode(node.parent) &&
        node.elements.some((element) => isGroupNode(element) && hasActionField(element))
    );
};

/**
 * Whether a `{}` group is a mod action entry: it declares an `Action = …` field and sits directly in
 * an actions list. This is the shape the game reads as an action regardless of which file the group
 * lives in, so it identifies action entries in an included fragment file (launcher.rules) exactly as
 * in a mod.rules manifest. The verb text itself is not required to be known here. A typo'd verb is
 * still an action entry, so its target is still exempt from the generic reference checks and the
 * "unknown verb" message comes from {@link import('./action-parser').parseModActions}.
 */
export const isActionEntryGroup = (group: GroupNode): boolean => hasActionField(group) && isActionsList(group.parent);

/**
 * Whether a value node is the `Name` of a mod action entry: the key the added member gets, never a
 * path of any kind. A ship entry keyed `Name = "Small Pirate Lootbox.ship.png"` names a file only by
 * convention, and reading it as an asset path reports a file the game never looks for.
 *
 * @param node the value node to inspect.
 * @returns true when the node is an action entry's `Name` value.
 */
export const isActionNameValueNode = (node: AbstractNode): boolean => {
    const parent = node.parent;
    if (!parent || !isGroupNode(parent) || !isActionEntryGroup(parent)) return false;
    return parent.elements.some(
        (element) => isAssignmentNode(element) && element.left.name.toLowerCase() === 'name' && element.right === node
    );
};

/**
 * Whether a value node is a mod action target path: the right-hand value of a target field
 * (`AddTo`/`OverrideIn`/`Replace`/`Remove`/`AddBaseTo = "<...>"`) in an action entry, or an element
 * of a `RemoveMany [ <path> … ]` list on one. Target paths resolve against the game Data root, not
 * the mod, and are written as quoted `"<...>"` strings rather than `&` references, so the generic
 * reference checks must skip them wherever an action lives, a mod.rules manifest or an included
 * fragment file. The enclosing group must be a real action entry ({@link isActionEntryGroup}), so a
 * same-named field outside an action is never exempted.
 */
export const isActionTargetValueNode = (node: AbstractNode): boolean => {
    const parent = node.parent;
    if (!parent) return false;
    // `RemoveMany [ <path> ]`: the node is a list element. The list is the target field and its
    // owner group is the action entry.
    if (isListNode(parent)) {
        const owner = parent.parent;
        return (
            !!parent.identifier &&
            isTargetField(parent.identifier.name) &&
            isGroupNode(owner as AbstractNode) &&
            isActionEntryGroup(owner as GroupNode)
        );
    }
    // `AddTo = "<...>"`: the node is the RHS of a target-field assignment in the action entry group.
    if (isGroupNode(parent)) {
        return (
            isActionEntryGroup(parent) &&
            parent.elements.some(
                (element) => isAssignmentNode(element) && element.right === node && isTargetField(element.left.name)
            )
        );
    }
    return false;
};
