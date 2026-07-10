import {
    AbstractNode,
    ListNode,
    GroupNode,
    ValueNode,
    isAssignmentNode,
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
 * `[]` list or `{}` group node (AddBase.AddBaseTo).
 *
 * Verbs that accept any target node (Add, Replace, Remove, …) leave this undefined.
 */
export type TargetShape = 'list' | 'container';

/** Per-verb field schema — the single source of truth for parsing, validation and completion. */
export interface VerbSchema {
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
     * reference). Only Overrides allows this — a file's top level is itself a group, so
     * Overrides can override its members. Every other verb must target a node inside a file.
     */
    allowsWholeFileTarget?: boolean;
    /** The optional `Name` key (Add only) — a key under which `ToAdd` is added, never a target. */
    named?: string;
}

export const VERB_SCHEMA: Record<ActionVerb, VerbSchema> = {
    Add: {
        targets: ['AddTo'],
        sources: ['ToAdd'],
        flags: ['OnlyIfNotExisting', 'CreateIfNotExisting', 'IgnoreIfNotExisting'],
        required: ['AddTo', 'ToAdd'],
        named: 'Name',
    },
    AddMany: {
        targets: ['AddTo'],
        sources: ['ManyToAdd'],
        flags: ['CreateIfNotExisting', 'IgnoreIfNotExisting'],
        required: ['AddTo', 'ManyToAdd'],
        sourceShape: 'list',
        targetShape: 'list',
    },
    Overrides: {
        targets: ['OverrideIn'],
        sources: ['Overrides'],
        flags: ['CreateIfNotExisting', 'IgnoreIfNotExisting'],
        required: ['OverrideIn', 'Overrides'],
        sourceShape: 'group',
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
    },
};

/** Every field name that holds a game-data target path (used to skip generic ref validation on them). */
export const TARGET_FIELDS = new Set<string>(Object.values(VERB_SCHEMA).flatMap((s) => s.targets));

const targetFieldKeys = new Set([...TARGET_FIELDS].map((name) => name.toLowerCase()));

/** Whether a written field name is a target field, ignoring case like the game's node lookup. */
export const isTargetField = (name: string): boolean => targetFieldKeys.has(name.toLowerCase());

/** Every field name that supplies source data (a reference or inline group/list). */
export const SOURCE_FIELDS = new Set<string>(Object.values(VERB_SCHEMA).flatMap((s) => s.sources));

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

/** Public alias kept stable — the registrar stores `Action[]`. */
export type Action = ModAction;

/** The case-insensitive name of the list that holds action entries, per the game's node lookup. */
const ACTIONS_LIST_NAME = 'actions';

/** Whether a node is an `Actions` list, matched case-insensitively like the game's node lookup. */
export const isActionsList = (node: AbstractNode | undefined): node is ListNode =>
    !!node && isListNode(node) && node.identifier?.name.toLowerCase() === ACTIONS_LIST_NAME;

/** Whether a `{}` group directly declares an `Action = …` field (the game's action-entry marker). */
const hasActionField = (group: GroupNode): boolean =>
    group.elements.some(
        (element) => isAssignmentNode(element) && element.left.name.toLowerCase() === 'action' && isValueNode(element.right)
    );

/**
 * Whether a `{}` group is a mod action entry: it declares an `Action = …` field and sits directly in
 * an `Actions` list. This is the shape the game reads as an action regardless of which file the group
 * lives in, so it identifies action entries in an included fragment file (launcher.rules) exactly as
 * in a mod.rules manifest. The verb text itself is not required to be known here — a typo'd verb is
 * still an action entry, so its target is still exempt from the generic reference checks and the
 * "unknown verb" message comes from {@link import('./action-parser').parseModActions}.
 */
export const isActionEntryGroup = (group: GroupNode): boolean => hasActionField(group) && isActionsList(group.parent);

/**
 * Whether a value node is a mod action TARGET path: the right-hand value of a target field
 * (`AddTo`/`OverrideIn`/`Replace`/`Remove`/`AddBaseTo = "<...>"`) in an action entry, or an element
 * of a `RemoveMany [ <path> … ]` list on one. Target paths resolve against the game Data root, not
 * the mod, and are written as quoted `"<...>"` strings rather than `&` references, so the generic
 * reference checks must skip them wherever an action lives — a mod.rules manifest or an included
 * fragment file. The enclosing group must be a real action entry ({@link isActionEntryGroup}), so a
 * same-named field outside an action is never exempted.
 */
export const isActionTargetValueNode = (node: AbstractNode): boolean => {
    const parent = node.parent;
    if (!parent) return false;
    // `RemoveMany [ <path> ]`: the node is a list element; the list is the target field and its
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
