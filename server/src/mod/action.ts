import { ListNode, GroupNode, ValueNode } from '../core/ast/ast';

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
    /** Names of all fields present on the entry (for required-field checks). */
    presentFields: Set<string>;
}

/** Public alias kept stable — the registrar stores `Action[]`. */
export type Action = ModAction;
