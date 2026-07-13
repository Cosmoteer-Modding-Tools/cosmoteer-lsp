/**
 * Bridge AST ⇄ schema: given a `.rules` group node, work out which schema class it represents.
 *
 * A group's concrete class is selected by its own `Type=<disc>` field (the `[SerialBaseType]`
 * dispatch). The containing list/group (e.g. `Components`) is itself custom-deserialized in the
 * engine, so it has no `[Serialize]` field linking it to the registry — instead we infer the
 * registry from any sibling's already-written `Type`, which is robust (a part's `Components` and a
 * bullet's `Components` disambiguate themselves by what their children declare).
 */
import {
    AbstractNode,
    AbstractNodeDocument,
    AssignmentNode,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import {
    classAncestry,
    classByDiscriminator,
    commonAncestorClass,
    fieldOf,
    fieldsOf,
    firstRegistryDeclaring,
    schema,
    typeDef,
} from './schema';
import { SchemaField, SchemaRegistry, ValueType } from './schema.types';
import { documentRootClass } from './document-root';
import { aliasedMemberType, inheritanceBaseCandidates } from './alias-root';
import { SHADER_GROUP_CLASS, TEXTURE_GROUP_CLASS } from './schema-overlay';
import { stepIntoNode } from '../../semantics/reference-resolver';
import { perfCount } from '../../utils/perf-counters';

/**
 * Top-level group identifiers that anchor a schema root class. The engine deserializes these from
 * a `.rules` file's root by name/convention (a part file's `Part` group → `PartRules`), which the
 * attribute model can't express. Extend as more document kinds get wired up.
 */
export const ROOT_GROUP_CLASSES: Record<string, string> = {
    Part: 'Cosmoteer.Ships.Parts.PartRules',
};

/**
 * Folder-scoped whole-file group roots: a `.rules` file whose root is a single named group whose
 * class is fixed by the folder it lives in rather than by a canonical identifier. A ship file is
 * `Asteroid : <base_ship.rules> { … }` — the group's name is the ship's own, so {@link
 * ROOT_GROUP_CLASSES} (which keys on a fixed name like `Part`) can't anchor it, but every ship under
 * `ships/`/`builtin_ships/` is a `ShipRules`. Applied only to a top-level group and only when the
 * group's fields are a majority of the candidate's (see {@link groupFitsClass}), so the part, wall and
 * sprite files that share the ships folders are not mis-rooted (parts anchor as `Part` earlier anyway).
 */
const ROOT_GROUP_BY_PATH: ReadonlyArray<{ readonly test: RegExp; readonly cls: string }> = [
    { test: /[/\\](?:ships|builtin_ships)[/\\]/i, cls: 'Cosmoteer.Ships.ShipRules' },
];

/** Minimum fraction of a root group's named members the candidate class must own to anchor it. */
const MIN_GROUP_ROOT_COVERAGE = 0.5;

/**
 * Whether `cls` is a plausible root for `group`: it must own a majority of the group's named members.
 * Guards the folder-scoped root against a non-ship group that happens to sit under a ships folder (a
 * group with too few members to judge, < 3, carries too little signal and is rejected, staying
 * unrooted rather than risking a mis-root).
 */
const groupFitsClass = (group: GroupNode, cls: string): boolean => {
    const names = group.elements
        .map((node) =>
            isAssignmentNode(node)
                ? node.left.name
                : isGroupNode(node) || isListNode(node)
                  ? node.identifier?.name
                  : undefined
        )
        .filter((name): name is string => !!name);
    if (names.length < 3) return false;
    const known = names.filter((name) => fieldOf(cls, name)).length;
    return known / names.length >= MIN_GROUP_ROOT_COVERAGE;
};

const ELEMENT_KINDS = new Set(['list', 'range', 'interpolated']);

// Slot and class resolution walk the parent chain per node and re-derive the same ancestors for
// every sibling, on every request. Both are memoized per AST node here. A node's resolution can
// also depend on cross-file rooting state (alias roots, reverse includes), which changes without
// the AST changing, so the memos carry an epoch that the server bumps whenever that state may have
// moved. An edit itself needs no bump: it produces a fresh AST whose nodes are new memo keys.
let contextEpoch = 0;

/** Invalidates the per-node slot/class memos after a rooting-state change. */
export const invalidateSchemaContextCache = (): void => {
    contextEpoch++;
    perfCount('schemaEpochBump');
};

/** Memo entries above this parent-chain depth are skipped so a depth-limited (truncated) walk
 *  can never persist its partial answer for a shallower caller. */
const MEMO_DEPTH_LIMIT = 24;

const slotTypeCache: WeakMap<AbstractNode, { epoch: number; value: ValueType | undefined }> = new WeakMap();
const groupClassCache: WeakMap<GroupNode, { epoch: number; value: string | undefined }> = new WeakMap();

/**
 * The schema value type the engine expects at a group/list node's slot, derived from the field that
 * declares its container. This is what makes nested resolution and collision-disambiguation work:
 * the declaring field names the exact class/registry, so a `Perlin` under a `TextureLayer`-typed
 * `Layers` resolves to TextureLayer, not (the colliding) HeightMapLayer. Returns undefined when the
 * container chain can't be anchored to a known class. Memoized per node and epoch.
 *
 * @param node the group or list whose slot type is wanted.
 * @param depth the current parent-chain recursion depth.
 * @returns the slot's schema type, or undefined when unanchorable.
 */
const expectedValueType = (node: GroupNode | ListNode, depth: number): ValueType | undefined => {
    const cached = slotTypeCache.get(node);
    if (cached && cached.epoch === contextEpoch) return cached.value;
    let value = expectedValueTypeUncached(node, depth);
    // A list written into a group-kind slot whose class delegates its value form to a collection
    // (`HitEffects [ … ]` on a MultiHitEffectRules) is read as that collection, so the list takes
    // the delegated type and its elements resolve (a typed hit-effect group, not a positional
    // digit field). The group spelling is untouched: it still reads the class's own fields.
    if (isListNode(node)) value = listValueFormOf(value) ?? value;
    if (depth <= MEMO_DEPTH_LIMIT) slotTypeCache.set(node, { epoch: contextEpoch, value });
    return value;
};

/**
 * The list-reading value form behind a group-kind slot, when its class carries one: a
 * `[Serialize(Alias = "")]` member typed as a collection binds the node itself to that member,
 * extracted by schemagen as the type's `valueForm`.
 *
 * @param slot the resolved slot type of a list node.
 * @returns the delegated element-carrying type, or undefined when the slot doesn't delegate.
 */
const listValueFormOf = (slot: ValueType | undefined): ValueType | undefined => {
    if (slot?.kind !== 'group') return undefined;
    const form = schema.types[slot.ref]?.valueForm;
    return form && ELEMENT_KINDS.has(form.kind) ? form : undefined;
};

/** A map-kind slot type, as the ValueType union declares it. */
type MapValueType = Extract<ValueType, { kind: 'map' }>;

/**
 * The written member names of a map's entry-list form and the type each carries: `Key` then
 * `Value`, or the `[KeyValuePairNames]` spellings the map declares (`Old`/`New`). The single source
 * of truth shared by slot typing, member lookup and entry-name completion, so the names completion
 * offers and the names validation accepts cannot drift apart.
 *
 * @param map the map-kind slot type.
 * @returns the entry member names paired with their value types, key first.
 */
export const mapEntryNames = (map: MapValueType): ReadonlyArray<readonly [string, ValueType]> => [
    [map.entryKey ?? 'Key', map.key],
    [map.entryValue ?? 'Value', map.value],
];

/**
 * The type an entry-form map member reads as, matched case-insensitively like the game's node
 * lookup.
 *
 * @param map the map-kind slot type.
 * @param member the written member name.
 * @returns the entry member's value type, or undefined when the member is neither entry name.
 */
export const mapEntryMemberType = (map: MapValueType, member: string): ValueType | undefined =>
    mapEntryNames(map).find(([name]) => name.toLowerCase() === member.toLowerCase())?.[1];

/**
 * The uncached slot resolution behind {@link expectedValueType}.
 *
 * @param node the group or list whose slot type is wanted.
 * @param depth the current parent-chain recursion depth.
 * @returns the slot's schema type, or undefined when unanchorable.
 */
const expectedValueTypeUncached = (node: GroupNode | ListNode, depth: number): ValueType | undefined => {
    if (depth > 32) return undefined;
    const parent = node.parent;
    if (!parent) return undefined;

    // The member name a container is declared under: its own identifier (`Foo { … }`, `Foo [ … ]`)
    // or, for the assignment spelling (`Foo = [ … ]`), the assignment naming it among the siblings.
    const memberName =
        node.identifier?.name ??
        ((isGroupNode(parent) || isDocumentNode(parent))
            ? parent.elements.find(
                  (element): element is AssignmentNode => isAssignmentNode(element) && element.right === node
              )?.left.name
            : undefined);

    if ((isGroupNode(parent) || isDocumentNode(parent)) && memberName) {
        if (isDocumentNode(parent)) {
            const rootClass = documentRootClass(parent);
            if (rootClass) return fieldOf(rootClass, memberName)?.valueType;
            // An unrooted top-level member: root it by how the game root aliases this fragment file in.
            return aliasedMemberType(parent, memberName);
        }
        // The container's slot memo feeds both the class resolution (resolveGroupClass reads the
        // same slot internally) and the map fallback below, so neither recomputes it per member.
        // Delegating the class chain to resolveGroupClass shares its per-group memo too, so K
        // members of one container cost one resolution, not K.
        const containerSlot = expectedValueType(parent, depth + 1);
        const ownerClass = resolveGroupClass(parent, depth + 1);
        if (ownerClass) return fieldOf(ownerClass, memberName)?.valueType;
        // A class-less container can still sit in a map-typed slot (a ToggledComponents part's
        // `Components` map, a planet's `Styles`). Its members are keys, so each member takes the
        // map's value type. Without this, such members fall back to sibling registry inference,
        // which picks the wrong registry for an ambiguous discriminator like `Type = ArcShield`.
        // An ENTRY group (the map reached the container through its entry-list form) instead types
        // its `Key`/`Value` members (or the `[KeyValuePairNames]` spellings, `Old`/`New`).
        if (containerSlot?.kind === 'map') {
            if (parent.parent && isListNode(parent.parent)) return mapEntryMemberType(containerSlot, memberName);
            return containerSlot.value;
        }
        // A range slot's group form (`TwinkleAddColor { Min = […] Max = […] }`): the engine reads
        // the `Value` or `Min`/`Max` keys as the range's element type, so those members type as the
        // element and everything below them (a positional color list, a nested group) resolves.
        if (containerSlot?.kind === 'range' && /^(value|min|max)$/i.test(memberName)) {
            return containerSlot.element;
        }
        return undefined;
    }

    if (isListNode(parent)) {
        let listType: ValueType | undefined;
        const grandparent = parent.parent;
        if (parent.identifier && grandparent && (isGroupNode(grandparent) || isDocumentNode(grandparent))) {
            const ownerClass = isDocumentNode(grandparent)
                ? documentRootClass(grandparent)
                : resolveGroupClass(grandparent, depth + 1);
            listType = ownerClass ? fieldOf(ownerClass, parent.identifier.name)?.valueType : undefined;
            if (!listType && isDocumentNode(grandparent)) listType = aliasedMemberType(grandparent, parent.identifier.name);
        } else {
            listType = expectedValueType(parent, depth + 1); // nested / assignment-form / inline list
        }
        // The identified-list fast path above reads the field type directly, bypassing the
        // central value-form substitution, so a delegating slot substitutes here too.
        listType = listValueFormOf(listType) ?? listType;
        if (listType && ELEMENT_KINDS.has(listType.kind) && 'element' in listType) return listType.element;
        // A group-typed slot written in its positional list form (`BaseSize = [7.2, 7.2]`): the game
        // deserializer reads element N through the class's digit field `"N"`, so the element's slot
        // is that field's type. Classes without a field for the index resolve to nothing. An
        // inheriting list (`X : base [ … ]`) appends its local elements after the inherited ones,
        // so the local index is not the game index and positional typing must stay silent.
        if (listType?.kind === 'group' && !parent.inheritance?.length) {
            const index = parent.elements.indexOf(node);
            if (index >= 0) return fieldOf(listType.ref, String(index))?.valueType;
        }
        // A tuple slot: element N's declared type is the tuple's Nth entry, so a nested list inside
        // a tuple (a career map picker's `[3, [faction, …]]`) resolves through its index too.
        if (listType?.kind === 'tuple' && !parent.inheritance?.length) {
            const index = parent.elements.indexOf(node);
            if (index >= 0) return listType.elements[index];
        }
        // A map written in its entry-list form (`Upgrades [ { Old=… New=… } ]`): the map type passes
        // through to each entry group, whose named members then resolve in the member branch below.
        if (listType?.kind === 'map') return listType;
        return undefined;
    }
    return undefined;
};

/** Registry FullName hint for a group's `Type=` dispatch, from its container's declared field type. */
export const registryHintFromContainer = (group: GroupNode, depth = 0): string | undefined => {
    const expected = expectedValueType(group, depth);
    return expected?.kind === 'polymorphicGroup' ? expected.ref : undefined;
};

/** The `Type=` discriminator value written in a group, if any. The field name matches case-insensitively like the game's node lookup. */
export const groupDiscriminator = (group: GroupNode, typeField = 'Type'): string | undefined => {
    for (const [name, value] of namedMembersOf(group)) {
        if (name.toLowerCase() !== typeField.toLowerCase()) continue;
        // `value` can be null for an in-progress empty `Type = ` assignment.
        if (value && isValueNode(value) && (value.valueType.type === 'String' || value.valueType.type === 'Reference')) {
            return String(value.valueType.value);
        }
    }
    return undefined;
};

/** The concrete schema class FullName a group represents, resolved from its own `Type` field. */
export const classOfGroup = (group: GroupNode, registryHint?: string): string | undefined => {
    const disc = groupDiscriminator(group);
    return disc ? classByDiscriminator(disc, registryHint) : undefined;
};

/**
 * Infer which polymorphic registry the child groups of `container` belong to, by reading the
 * `Type` of any sibling that already has one. Returns undefined for an empty/typeless container.
 */
export const registryForContainer = (container: GroupNode): SchemaRegistry | undefined => {
    for (const element of container.elements) {
        if (!isGroupNode(element)) continue;
        const disc = groupDiscriminator(element);
        if (!disc) continue;
        const registry = firstRegistryDeclaring(disc);
        if (registry) return registry;
    }
    return undefined;
};

/**
 * The polymorphic registry a group belongs to (so we know its `Type=` discriminator set): the slot's
 * declared registry (works for a typed list element too), else inferred from a typed sibling in the
 * same container. The single resolution shared by `Type=` value completion and the field-name
 * completion that suggests writing `Type` first.
 */
export const registryForGroup = (group: GroupNode): SchemaRegistry | undefined => {
    const slot = registryHintFromContainer(group);
    if (slot) return schema.registries[slot];
    const container = group.parent;
    return container && isGroupNode(container) ? registryForContainer(container) : undefined;
};

/** The named members (fields, subgroups, sublists) a group declares, excluding the structural `Type=`. */
const ownedFieldNames = (group: GroupNode): string[] =>
    group.elements
        .map((node) =>
            isAssignmentNode(node)
                ? node.left.name
                : isGroupNode(node) || isListNode(node)
                  ? node.identifier?.name
                  : undefined
        )
        .filter((name): name is string => !!name && name.toLowerCase() !== 'type');

/**
 * Root an inheritance-base fragment group — a top-level group in an unrooted document, pulled in only as
 * a `Derived : <file>/Base` — to the deriver class that best fits its own fields. A base file often writes
 * fields that live on a DERIVED class (the `commands/base_command.rules` `BaseCommand` group declares the
 * move widgets, which are on `MoveCommandRules`, not the shared `BaseCommandRules`), so the shallow common
 * ancestor would leave those unresolved. Among every deriver class and its ancestors, plus the group's
 * own slot class, this picks the most-derived (most fields) candidate that owns every field the group
 * declares, guaranteeing full completion with no new unknown-field warning. It falls back to the
 * common ancestor when none covers the group (a base mixing unrelated derived fields stays safely
 * shallow rather than mis-rooted).
 *
 * The slot class joins the candidates because a base can be BOTH aliased in as a field and inherited
 * by classes on other branches: `command_follow.rules`'s `FollowCommand` is the `Commands.Follow` slot
 * (a `FollowCommandRules`, which owns every field) while its derivers (`SalvageCommand`,
 * `FtlGateJumpCommand`) sit on sibling branches whose ancestries never contain it.
 *
 * @param group the candidate base group.
 * @param slotClass the class the group's own slot resolves to, as {@link classFromSlot} returns it.
 * @returns the best-fitting class FullName, or undefined when the group isn't an inheritance base.
 */
const inheritedBaseClassForGroup = (group: GroupNode, slotClass?: string): string | undefined => {
    const parent = group.parent;
    if (!parent || !isDocumentNode(parent) || !group.identifier) return undefined;
    const deriverClasses = inheritanceBaseCandidates(parent, group.identifier.name);
    if (deriverClasses.length === 0) return undefined;
    // A rooted document blocks base rooting only when its root class actually owns the group's
    // name, where slot typing gives the better answer. A named wrapper group the root class does
    // not know (a shots-folder munitions fragment whose groups are inherited into components)
    // would otherwise stay dark even though its derivers know its class.
    const parentRoot = documentRootClass(parent);
    if (parentRoot && fieldOf(parentRoot, group.identifier.name)) return undefined;
    const names = ownedFieldNames(group);
    const candidates = new Set<string>();
    for (const cls of deriverClasses) for (const ancestor of classAncestry(cls)) candidates.add(ancestor);
    if (slotClass) for (const ancestor of classAncestry(slotClass)) candidates.add(ancestor);
    let best: string | undefined;
    let bestFieldCount = -1;
    for (const candidate of candidates) {
        if (!names.every((name) => !!fieldOf(candidate, name))) continue;
        const count = fieldsOf(candidate).length;
        if (count > bestFieldCount) {
            best = candidate;
            bestFieldCount = count;
        }
    }
    return best ?? commonAncestorClass(deriverClasses);
};

/**
 * Resolves a same-file reference path to its target node, for the synchronous inheritance walk. Only
 * same-file forms resolve here: a `<file>` ref or a game-root super-path needs the async resolver
 * and yields undefined. The walk dereferences any reference value it lands on mid-path (an `^/0`
 * step lands on the owner container's base entry, itself a `~/TEMPLATE` reference that must resolve
 * before the next segment can step into it), recursing with the same same-file rules; `depth`
 * bounds cyclic bases the way it bounds {@link resolveGroupClass}.
 *
 * @param raw the reference text as written (with or without the `&` sigil).
 * @param owner the group or list the reference belongs to (the deriving node for a base entry).
 * @param depth the {@link resolveGroupClass} recursion depth, forwarded as the cycle guard.
 * @returns the target node, or undefined when the path does not resolve within this file.
 */
const sameFileReferenceTarget = (
    raw: string,
    owner: GroupNode | ListNode,
    depth: number
): AbstractNode | undefined => {
    if (depth > 32) return undefined;
    const cleaned = raw.trim().replace(/^&\s*/, '');
    if (!cleaned || cleaned.includes('<') || cleaned.startsWith('/')) return undefined;
    const segments = cleaned.split('/').map((s) => s.trim()).filter(Boolean);
    if (segments.length === 0) return undefined;
    let node: AbstractNode | null | undefined;
    let index = 0;
    let previous = '';
    if (segments[0] === '^') {
        // A leading `^` on a base reference selects the OWNER'S CONTAINER'S inheritance anchor (the
        // inheriting member inherits from the same-named member of its container's base), matching
        // stepIntoNode's climb from the base value node, whose parent is the deriving node itself.
        // A top-level owner has no such anchor, so the path stays unresolved.
        if (!owner.parent || !(isGroupNode(owner.parent) || isListNode(owner.parent))) return undefined;
        node = owner.parent;
        index = 1;
        previous = '^';
    } else if (segments[0] === '~' || segments[0] === '..') {
        node = owner;
    } else {
        // A relative first segment names a member of an enclosing scope: an inheritance ref
        // resolves against the deriving node's container chain, nearest scope first.
        let scope: AbstractNode | undefined = owner.parent;
        while (scope && !node) {
            if (isGroupNode(scope) || isDocumentNode(scope)) node = stepIntoNode(scope, segments[0]) ?? undefined;
            scope = scope.parent;
        }
        if (!node) return undefined;
        index = 1;
    }
    for (; index < segments.length && node; index++) {
        node = dereferenceValue(node, depth);
        if (!node) return undefined;
        node = stepIntoNode(node, segments[index], previous === '^');
        previous = segments[index];
    }
    return node ? dereferenceValue(node, depth) : undefined;
};

/**
 * Follows a reference-valued node to its target within the same file: an `^/0` step lands on a base
 * entry whose value is itself a reference (`~/TEMPLATE`), which resolves relative to its own owning
 * node before the walk continues. Non-reference nodes pass through unchanged.
 *
 * @param node the node the walk landed on.
 * @param depth the recursion depth forwarded to the nested resolution.
 * @returns the dereferenced node, or undefined when a reference in the chain does not resolve.
 */
const dereferenceValue = (node: AbstractNode, depth: number): AbstractNode | undefined => {
    if (!isValueNode(node) || node.valueType.type !== 'Reference') return node;
    const owner = node.parent;
    if (!owner || !(isGroupNode(owner) || isListNode(owner))) return undefined;
    return sameFileReferenceTarget(String(node.valueType.value), owner, depth + 1);
};

/**
 * Follows a group's same-file inheritance bases synchronously to the class the base carries. The
 * async resolver covers every base form for completion, but hover, validation and slot typing run
 * synchronously, so a component inheriting a same-file template (`BulletEmitter : ~/EMITTER`,
 * `X : SiblingTemplate`, `Y : ^/0/Y`) was dark to them. Cross-file bases (`<file>`, `&/GLOBAL`)
 * still need the async path and are skipped. The first base that yields a class wins.
 *
 * @param group the deriving group.
 * @param depth the {@link resolveGroupClass} recursion depth, forwarded as the cycle guard.
 * @returns the inherited class FullName, or undefined.
 */
const sameFileInheritedClass = (group: GroupNode, depth: number): string | undefined => {
    for (const base of group.inheritance ?? []) {
        if (!isValueNode(base) || base.valueType.type !== 'Reference') continue;
        const target = sameFileReferenceTarget(String(base.valueType.value), group, depth);
        if (target && isGroupNode(target) && target !== group) {
            const cls = resolveGroupClass(target, depth + 1);
            if (cls) return cls;
        }
    }
    return undefined;
};

/**
 * Resolve the schema class a group represents, top-down. A class is known when the group:
 *  1. sits in a slot whose declaring field types it — a concrete `group` field gives the class
 *      directly. A `polymorphicGroup` field gives the registry, and the group's `Type=` picks the
 *      member (disambiguating collisions), or
 *  2. carries its own `Type=` discriminator with no slot hint, or
 *  3. is a known root group (e.g. `Part`), or
 *  4. is a pure inheritance base rooted by the deriver class that best fits its fields.
 */
export const resolveGroupClass = (group: GroupNode, depth = 0): string | undefined => {
    if (depth > 32) return undefined;
    const cached = groupClassCache.get(group);
    if (cached && cached.epoch === contextEpoch) return cached.value;
    // A top-level group reachable only as a cross-file inheritance base: root it to the class that
    // best fits its own fields among the derivers and the slot class, ahead of the shallower
    // common-ancestor type either would yield alone. A group neither roots, with a same-file base
    // inherits the base's class (inheritance preserves type).
    const slotClass = classFromSlot(group, expectedValueType(group, depth));
    const value =
        inheritedBaseClassForGroup(group, slotClass) ??
        slotClass ??
        sameFileInheritedClass(group, depth);
    if (depth <= MEMO_DEPTH_LIMIT) groupClassCache.set(group, { epoch: contextEpoch, value });
    return value;
};

/**
 * The slot-driven part of {@link resolveGroupClass}, taking the group's already-resolved slot type so
 * a caller that needs the slot for its own purposes does not trigger a second recursive resolution.
 *
 * @param group the group whose class is wanted.
 * @param expected the group's slot type, as {@link expectedValueType} returns it.
 * @returns the class FullName, or undefined when the group cannot be anchored.
 */
/** Whether a group written in a range slot uses the engine's range keys (`Value`, or `Min`/`Max`). */
const usesRangeKeys = (group: GroupNode): boolean =>
    namedMembersOf(group).some(([name]) => /^(value|min|max)$/i.test(name));

const classFromSlot = (group: GroupNode, expected: ValueType | undefined): string | undefined => {
    if (expected?.kind === 'group') {
        // A wrapper class delegating its value form to a registry (`[Serialize(Alias="")]` on a
        // polymorphic member: a name-generator entry, a stat widget wrapper, a brush) reads BOTH
        // its own fields and the dispatched member's, written flat in one group. A single class
        // must answer here, so the side that owns more of the group's written names wins: the stat
        // widgets' fields live on the member (StatBarRules), the brushes' on the wrapper
        // (BrushRules' NameKey/Icon). The wrapper stays the answer on a tie or without a `Type=`.
        const delegated = typeDef(expected.ref)?.valueForm;
        if (delegated?.kind === 'polymorphicGroup') {
            const registry = schema.registries[delegated.ref];
            const viaType = classOfGroup(group, registry?.name);
            if (viaType) {
                const names = ownedFieldNames(group);
                const owned = (cls: string) => names.filter((name) => !!fieldOf(cls, name)).length;
                if (owned(viaType) > owned(expected.ref)) return viaType;
            }
        }
        return expected.ref;
    }
    // A range slot filled with a group: the engine reads `Value` or `Min`/`Max` keys (each of the
    // element type), and otherwise the whole group AS the element. So an element-shaped group (a
    // bullet `Speed { BaseValue … }` in a range<Modifiable> slot) resolves to the element's group
    // class, while a `{ Min … Max … }` group keeps no class and its keys type through the member
    // branch of expectedValueType instead.
    if (expected?.kind === 'range' && !usesRangeKeys(group)) {
        const element = expected.element;
        if (element.kind === 'group') return element.ref;
        if ((element.kind === 'number' || element.kind === 'int' || element.kind === 'float') && element.groupForm) {
            return element.groupForm;
        }
    }
    if (expected?.kind === 'polymorphicGroup') {
        const registry = schema.registries[expected.ref];
        const viaType = classOfGroup(group, registry?.name);
        if (viaType) return viaType;
        // A group whose `Type` comes through its inheritance (`MyTurret : BaseTurret { }`) must stay
        // unresolved here so the inheritance resolution decides, rather than pinning the registry
        // base and hiding every derived field.
        if (group.inheritance?.length) return undefined;
        return expected.ref;
    }
    // A scalar value with a group form (a `Modifiable<T>` written as `{ BaseValue = … BuffType = … }`):
    // when the slot is filled with a group, its fields come from the curated group-form class.
    if (
        (expected?.kind === 'number' || expected?.kind === 'int' || expected?.kind === 'float') &&
        expected.groupForm
    ) {
        return expected.groupForm;
    }
    // A `Texture` is dual-form: a bare image path OR a `{ File … SampleMode … }` group. schemagen only
    // captured the scalar form (`asset`), so an image-asset slot written as a group is the group form —
    // the only dual-form image type in the engine — resolved to the overlay's Texture class.
    if (expected?.kind === 'asset' && expected.assetKind === 'image') return TEXTURE_GROUP_CLASS;
    // A `Shader` is dual-form the same way: a bare path or `{ File … VertexEntryPoint … }`.
    if (expected?.kind === 'asset' && expected.assetKind === 'shader') return SHADER_GROUP_CLASS;
    // No slot hint: infer the registry from a typed sibling in the same container so an ambiguous
    // discriminator resolves to the right registry for this context. A bullet's `GlowSprite { Type =
    // Sprite }` and a part's `Sprite { Type = Sprite }` both write `Sprite`, but they belong to
    // different registries (`BulletSpriteRules` vs `PartSpriteRules`) — the container's other
    // components (`Type = CirclePhysics` vs `Type = TurretWeapon`) tell them apart.
    const container = group.parent;
    const containerRegistry = container && isGroupNode(container) ? registryForContainer(container) : undefined;
    const viaType = classOfGroup(group, containerRegistry?.name);
    if (viaType) return viaType;
    const id = group.identifier?.name;
    if (id && ROOT_GROUP_CLASSES[id]) return ROOT_GROUP_CLASSES[id];
    // A top-level named group whose class is fixed by its folder (a ship under `ships/`), guarded by
    // field coverage so the part/wall/sprite files sharing those folders are not mis-rooted.
    if (group.parent && isDocumentNode(group.parent)) {
        const uri = group.parent.uri.replace(/\\/g, '/');
        const rule = ROOT_GROUP_BY_PATH.find((r) => r.test.test(uri));
        if (rule && groupFitsClass(group, rule.cls)) return rule.cls;
    }
    return undefined;
};

/**
 * The classes whose members are legal in a group, primary first. Usually just the resolved class,
 * but a group filling a wrapper-with-polymorphic-value-form slot is read TWICE by the engine (the
 * wrapper's own fields and the dispatched member's, written flat in one group), while
 * {@link resolveGroupClass} stays single-valued with whichever side owns more of the written names.
 * The losing side's fields are still read, so member lookup, field completion and the ignored-field
 * judgement consult the delegation companion too. Reuses the memoized slot and class resolutions,
 * so the companion derivation adds no new caches.
 *
 * @param group the group whose member-owning classes are wanted.
 * @returns the primary class first, plus the delegation companion when the slot carries one; empty
 *          when the group resolves to no class at all.
 */
export const groupClassCandidates = (group: GroupNode): string[] => {
    const primary = resolveGroupClass(group);
    if (!primary) return [];
    const expected = expectedValueType(group, 0);
    if (expected?.kind === 'group') {
        const delegated = typeDef(expected.ref)?.valueForm;
        if (delegated?.kind === 'polymorphicGroup') {
            const registry = schema.registries[delegated.ref];
            const member = classOfGroup(group, registry?.name);
            const companion = primary === expected.ref ? member : primary === member ? expected.ref : undefined;
            if (companion && companion !== primary) return [primary, companion];
        }
    }
    return [primary];
};

// Reverse index for wrapper delegation: registry member class → the wrapper classes whose value
// form (a `[Serialize(Alias="")]` polymorphic member) delegates to a registry declaring it. Built
// lazily on first use; the schema is immutable after load, so it never goes stale.
let wrapperClassesByMember: Map<string, string[]> | undefined;

const wrapperClassIndex = (): Map<string, string[]> => {
    if (wrapperClassesByMember) return wrapperClassesByMember;
    wrapperClassesByMember = new Map();
    for (const [fullName, def] of Object.entries(schema.types)) {
        const form = def.valueForm;
        if (form?.kind !== 'polymorphicGroup') continue;
        const registry = schema.registries[form.ref];
        if (!registry) continue;
        for (const member of Object.values(registry.members)) {
            const wrappers = wrapperClassesByMember.get(member);
            if (!wrappers) wrapperClassesByMember.set(member, [fullName]);
            else if (!wrappers.includes(fullName)) wrappers.push(fullName);
        }
    }
    return wrapperClassesByMember;
};

/**
 * The wrapper classes that could carry a group resolved to `cls` as their delegated payload: every
 * type whose value form dispatches to a registry declaring `cls` (or an ancestor of it) as a member.
 * Such a wrapper reads its own fields and the dispatched member's from the same flat group, so when
 * a group self-resolves without a slot (an unrooted fragment wired in through mod actions), a field
 * any of these classes owns may still be read by the game.
 *
 * @param cls the resolved member class FullName.
 * @returns the wrapper class FullNames; empty when no wrapper delegates to a registry containing
 *          the class.
 */
export const possibleWrapperClasses = (cls: string): readonly string[] => {
    const index = wrapperClassIndex();
    const out: string[] = [];
    for (const ancestor of classAncestry(cls)) {
        for (const wrapper of index.get(ancestor) ?? []) {
            if (!out.includes(wrapper)) out.push(wrapper);
        }
    }
    return out;
};

/**
 * Whether a group's slot resolves to a declared schema type, anchoring its class resolution to the
 * container chain. An unanchored group's class is self-resolved (its own `Type=` against a global
 * or sibling-inferred registry), which cannot see a wrapper the real slot might carry.
 *
 * @param group the group node to test.
 * @returns true when the field declaring the group's container chain types its slot.
 */
export const groupSlotIsAnchored = (group: GroupNode): boolean => expectedValueType(group, 0) !== undefined;

/**
 * The schema type expected at top-level (or nested) member `member` of `container`, which is either a
 * group node or the document root. A rooted container reads the type straight off its class; a map
 * container types every member as its value type (the member is a key, e.g. a planet style `Styles {
 * alien = &<…> }`); an unrooted top-level member falls back to how the game root (or a reverse
 * `&<include>`) aliases this fragment file in. This is the primitive the reverse-include index uses to
 * type an `&<file>` include by the field that declares it, wherever that field sits.
 *
 * @param container the group or document the member is declared in.
 * @param member the declared member name.
 * @returns the schema type at that slot, or undefined when the container can't be anchored to a class.
 */
export const memberTypeIn = (
    container: GroupNode | AbstractNodeDocument,
    member: string
): ValueType | undefined => {
    if (isDocumentNode(container)) {
        const root = documentRootClass(container);
        if (root) return fieldOf(root, member)?.valueType;
        return aliasedMemberType(container, member);
    }
    // A wrapper-delegation slot answers through whichever candidate class owns the member (the
    // primary first); a resolved group whose candidates all miss the member stays undefined without
    // falling into the map branch below.
    const candidates = groupClassCandidates(container);
    if (candidates.length > 0) {
        for (const cls of candidates) {
            const field = fieldOf(cls, member);
            if (field) return field.valueType;
        }
        return undefined;
    }
    // A map-typed group (`Styles { alien = &<…> }`) has no class of its own; its members are keys, so
    // every one takes the map's value type. An entry group (reached through the map's entry-list
    // form) instead types its `Key`/`Value` members (or the `[KeyValuePairNames]` spellings).
    const expected = expectedValueType(container, 0);
    if (expected?.kind === 'map') {
        if (container.parent && isListNode(container.parent)) return mapEntryMemberType(expected, member);
        return expected.value;
    }
    // A range slot's group form reads its `Value`/`Min`/`Max` keys as the element type.
    if (expected?.kind === 'range' && /^(value|min|max)$/i.test(member)) return expected.element;
    return undefined;
};

/**
 * The element type of a list node — what the schema expects at each of its slots. Resolves the list's
 * own declared type (through the same container/alias anchoring as everything else) and unwraps its
 * element. Used to type an `&<file>` include written as a bare list element (a codex `CodexPages [
 * &<page> ]`), so the included fragment roots as the element class.
 *
 * @param list the list node whose element type is wanted.
 * @returns the element schema type, or undefined when the list can't be typed.
 */
export const listElementType = (list: ListNode): ValueType | undefined => {
    const listType = expectedValueType(list, 0);
    return listType && ELEMENT_KINDS.has(listType.kind) && 'element' in listType ? listType.element : undefined;
};

/**
 * The schema field a positional list element reads through, when the list sits in a group-typed
 * slot: `BaseSize = [7.2, 7.2]` → index 1 is Vector2's `"1"` field, and an `EditorParentParts`
 * entry `[part, 0]` → index 0 is EditorParentPart's `"0"` reference field.
 *
 * @param list the list whose element is asked about.
 * @param index the element's position in the list.
 * @returns the digit field for that index, or undefined when the list's slot is not a group class
 *          or the class has no field for the index.
 */
export const positionalElementField = (list: ListNode, index: number): SchemaField | undefined => {
    // An inheriting list appends local elements after the inherited ones, shifting every index.
    if (list.inheritance?.length) return undefined;
    const slot = expectedValueType(list, 0);
    return slot?.kind === 'group' ? fieldOf(slot.ref, String(index)) : undefined;
};

/**
 * The element index the byte offset falls in: the element containing it, else how many elements
 * end before it (the slot a newly typed element would take).
 *
 * @param list the list containing the offset.
 * @param offset the cursor byte offset.
 * @returns the positional index at the offset.
 */
const positionalIndexAt = (list: ListNode, offset: number): number => {
    for (const [index, element] of list.elements.entries()) {
        if (offset >= element.position.start && offset <= element.position.end) return index;
    }
    return list.elements.filter((element) => element.position.end < offset).length;
};

/**
 * The deepest node satisfying `matches` whose byte-offset range contains `offset` (where a new child
 * would be typed). A pre-order DFS, so deeper containing nodes overwrite shallower ones.
 */
const findEnclosing = <T extends AbstractNode>(
    document: AbstractNodeDocument,
    offset: number,
    matches: (node: AbstractNode) => node is T
): T | undefined => {
    let best: T | undefined;
    const visit = (node: AbstractNode | null | undefined): void => {
        if (!node) return; // an empty `Key = ` assignment has a null right-hand value
        // The last container of a file keeps `position.end` at 0 (the parser's container-position
        // invariant), which would exclude every offset inside it. Treat such an end as open-ended;
        // a deeper properly-ended container still wins the deepest-match scan. The end is only read
        // on a match, because an assignment node carries no position at all.
        if (matches(node) && offset >= node.position.start) {
            const end = node.position.end > node.position.start ? node.position.end : Number.MAX_SAFE_INTEGER;
            // `position.end` is one past the closing brace, so a cursor at exactly `end` sits after
            // the closer and types into the parent container, not into this one.
            if (offset < end) best = node;
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) visit(child);
    };
    for (const element of document.elements) visit(element);
    return best;
};

/** The deepest group whose byte-offset range contains `offset` (where a new field would be typed). */
export const findEnclosingGroup = (document: AbstractNodeDocument, offset: number): GroupNode | undefined =>
    findEnclosing(document, offset, isGroupNode);

/**
 * Finds the deepest list whose byte-offset range contains a position, which is where a new list
 * element would be typed.
 *
 * @param document the parsed document.
 * @param offset the cursor byte offset.
 * @returns the innermost list node containing the offset, or undefined when the offset is in no list.
 */
export const findEnclosingList = (document: AbstractNodeDocument, offset: number): ListNode | undefined =>
    findEnclosing(document, offset, isListNode);

/**
 * The deepest group or list whose byte-offset range contains a position, which is the container a
 * member typed at the offset actually lands in. Distinguishes a list-element position
 * (`Offset [ <cursor> ]`) from a group-member position, which {@link findEnclosingGroup} alone
 * cannot (it skips lists, so a cursor inside brackets would resolve to the outer group).
 *
 * @param document the parsed document.
 * @param offset the cursor byte offset.
 * @returns the innermost group or list containing the offset, or undefined at the top level.
 */
export const findEnclosingContainer = (
    document: AbstractNodeDocument,
    offset: number
): GroupNode | ListNode | undefined =>
    findEnclosing(
        document,
        offset,
        (node): node is GroupNode | ListNode => isGroupNode(node) || isListNode(node)
    );

/**
 * The schema type of the slot a list node fills, resolved from the field that declares it (an
 * `Offset [ … ]` under a StandardQuadRenderer resolves to the Vector2 `group` type). The public
 * face of the internal slot resolution for callers that hold a list and need to know what the
 * engine reads it as.
 *
 * @param list the list node whose declared slot type is wanted.
 * @returns the slot's schema type, or undefined when the list can't be anchored.
 */
export const listSlotType = (list: ListNode): ValueType | undefined => expectedValueType(list, 0);

/**
 * The class whose members are in scope at a byte offset, which is what field-name lookup, value
 * completion and channel completion must resolve names against. Usually this is the innermost
 * group's class (or the document root class at the top level). When the innermost container is a
 * list, the scope is the list's slot instead: a group-typed field written in list form (an
 * `Offset [ … ]` reading as Vector2) scopes to that class, and any other list (references,
 * scalars, group elements) has no member scope at all, so the enclosing group's fields never leak
 * through the brackets.
 *
 * @param document the parsed document.
 * @param offset the cursor byte offset.
 * @returns the class FullName in scope, or undefined when the position has none.
 */
export const memberScopeClassAt = (document: AbstractNodeDocument, offset: number): string | undefined => {
    const container = findEnclosingContainer(document, offset);
    if (!container) return documentRootClass(document);
    if (isListNode(container)) {
        const slot = listSlotType(container);
        return slot?.kind === 'group' ? slot.ref : undefined;
    }
    return resolveGroupClass(container);
};

/**
 * Resolves the reference target class of a list's elements when the list is declared as a
 * `list<reference X>` field, so completion can offer X ids at a list element position.
 *
 * @param list the list node whose element type is wanted.
 * When `offset` is given, a positional element of a group-typed slot also resolves: inside an
 * `EditorParentParts` entry (`[<cursor>, 0]`) the index at the cursor selects the class's digit
 * field, whose reference target is offered.
 *
 * @param list the list node whose element is being completed.
 * @param offset the cursor byte offset, enabling positional (index-dependent) resolution.
 * @returns the element reference target class FullName, or undefined when the position is not reference-typed.
 */
export const listElementReferenceTarget = (list: ListNode, offset?: number): string | undefined => {
    const owner = list.parent;
    if (!owner) return undefined;
    let fieldName = list.identifier?.name;
    if (!fieldName && (isGroupNode(owner) || isDocumentNode(owner))) {
        for (const element of owner.elements) {
            if (isAssignmentNode(element) && element.right === list) {
                fieldName = element.left.name;
                break;
            }
        }
    }
    if (fieldName) {
        const ownerClass = isDocumentNode(owner)
            ? documentRootClass(owner)
            : isGroupNode(owner)
              ? resolveGroupClass(owner)
              : undefined;
        const valueType = ownerClass ? fieldOf(ownerClass, fieldName)?.valueType : undefined;
        if (
            (valueType?.kind === 'list' || valueType?.kind === 'range' || valueType?.kind === 'interpolated') &&
            valueType.element.kind === 'reference'
        ) {
            return valueType.element.target;
        }
    }
    if (offset !== undefined) {
        const index = positionalIndexAt(list, offset);
        const positional = positionalElementField(list, index);
        if (positional?.valueType.kind === 'reference') return positional.valueType.target;
        // An inheriting list appends its elements after the inherited ones, shifting every index, so
        // positional resolution through the slot must stay silent there.
        if (!list.inheritance?.length) {
            const slot = listSlotType(list);
            // A tuple slot (a part's `Resources [ [bullet, 20] ]` entry): the element's index picks
            // the declared entry type.
            if (slot?.kind === 'tuple') {
                const element = slot.elements[index];
                if (element?.kind === 'reference') return element.target;
            }
            if (slot && ELEMENT_KINDS.has(slot.kind) && 'element' in slot) {
                // A list slot reached without a field name, e.g. a list nested inside a tuple entry
                // (`CandidatesClosestToFactions = [3, [faction, …]]`).
                if (slot.element.kind === 'reference') return slot.element.target;
                // A scalar-form group element (`EditorParentParts = ["cosmoteer.armor"]`): a bare
                // entry reads as the element class's `0` reference field. A container entry resolves
                // through its own slot instead, so only value (or empty) positions take this path.
                if (slot.element.kind === 'group') {
                    const entry = list.elements[index];
                    if (!entry || isValueNode(entry)) {
                        const first = fieldOf(slot.element.ref, '0');
                        if (first?.valueType.kind === 'reference') return first.valueType.target;
                    }
                }
            }
        }
    }
    return undefined;
};
