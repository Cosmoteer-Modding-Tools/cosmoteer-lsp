/**
 * Cross-file list-element entities — the second kind of `ID<X>` target, alongside whole-file roots.
 *
 * Many `ID<X>` references point not at a whole-file root (a resource/nebula file with a top-level
 * `ID`) but at an element of an aggregate list reachable from the game root `Cosmoteer.Data.Rules`:
 * a faction in `factions.rules`'s `Factions [ { ID = … } … ]`, a GUI toggle in `part_toggles.rules`'s
 * `PartToggles [ { ToggleID = … } … ]`, a career tech, an encounter, a ship door, …
 *
 * This module derives, from the schema alone, which list fields hold such entities and how each
 * element is identified, so the index/navigation can harvest `(class, id)` declarations from a file
 * without resolving the alias graph that wires the fragment into `cosmoteer.rules`:
 *  - {@link ENTITY_FIELDS}: list field name → the element class it holds and that class's identity
 *    key field. Keyed by field name because each fragment file surfaces the list as a top-level (or
 *    nested) member of that exact name (`Factions [ … ]`, `PartToggles [ … ]`). Field names that map
 *    to more than one element class are dropped (ambiguous → conservative).
 *  - {@link entityDeclarationsOf}: walk a document and yield every entity declaration it contains.
 *
 * Identity key per class: the `ID` field if present, else the unique self-referential `…ID` field
 * (the GUI entities carry `ColorID`/`ToggleID`/… as their own SerialID). Classes with neither — e.g.
 * group-keyed kinds (damage types, part categories) or `Key`/`Value` lists (render layers) — are not
 * covered here (a later phase).
 */
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { fieldsOf, schema } from './schema';
import { ValueType } from './schema.types';
import { aliasRootIndex } from './alias-root';
import { listSlotType } from './schema-context';

const ROOT_CLASS = 'Cosmoteer.Data.Rules';

/** The element class(es) a list/group/polymorphic field declares (flattening nested list element types). */
const elementClassesOf = (valueType: ValueType): string[] => {
    switch (valueType.kind) {
        case 'group':
            return [valueType.ref];
        case 'polymorphicGroup':
            return Object.values(schema.registries[valueType.ref]?.members ?? {});
        case 'list':
        case 'range':
        case 'interpolated':
            return elementClassesOf(valueType.element);
        default:
            return [];
    }
};

/** Every class targeted by some `ID<X>` reference field anywhere in the schema (the "consumer" side). */
const referenceTargets = ((): Set<string> => {
    const out = new Set<string>();
    for (const type of Object.values(schema.types)) {
        for (const field of type.fields) {
            if (field.valueType.kind === 'reference') out.add(field.valueType.target);
        }
    }
    return out;
})();

/** The field that identifies an instance of `cls`: `ID`, else the unique self-referential `…ID`. */
const identityKeyOf = (cls: string): string | undefined => {
    const fields = fieldsOf(cls);
    if (fields.some((field) => field.name === 'ID')) return 'ID';
    const selfIds = fields.filter(
        (field) =>
            field.name.endsWith('ID') &&
            field.valueType.kind === 'reference' &&
            field.valueType.target === cls
    );
    return selfIds.length === 1 ? selfIds[0].name : undefined;
};

export interface EntityField {
    /** The C# FullName of the element class held in this list. */
    readonly elementClass: string;
    /** The field on each element that carries its id (`ID`, `ColorID`, `ToggleID`, …). */
    readonly identityKey: string;
}

/**
 * Lower-cased list field name → the entity candidate(s) it declares. Derived once: BFS the group/list field graph
 * from `Cosmoteer.Data.Rules`, and for every list field whose element class is a reference target with
 * a resolvable identity key, record `fieldName → {elementClass, identityKey}`.
 *
 * A field name reachable with two different element classes (e.g. `Techs` = career `TechRules` vs
 * build-battle `BuildBattleTechRules`) keeps both candidates rather than being dropped: a file
 * surfaces the list by name without its root context, so we index each element under every candidate
 * class and let the query-time `isSameOrSubclass(elementClass, targetClass)` filter pick the right one
 * (the same mechanism whole-file roots use). The only cost is a stray cross-registry completion entry.
 */
export const ENTITY_FIELDS: ReadonlyMap<string, readonly EntityField[]> = (() => {
    const found = new Map<string, EntityField[]>();
    const seen = new Set<string>();
    const stack: string[] = [ROOT_CLASS];
    while (stack.length) {
        const cls = stack.pop()!;
        if (seen.has(cls)) continue;
        seen.add(cls);
        for (const field of fieldsOf(cls)) {
            const elementClasses = elementClassesOf(field.valueType);
            for (const elementClass of elementClasses) if (!seen.has(elementClass)) stack.push(elementClass);
            if (field.valueType.kind !== 'list' && field.valueType.kind !== 'range' && field.valueType.kind !== 'interpolated') {
                continue;
            }
            for (const elementClass of elementClasses) {
                if (!referenceTargets.has(elementClass)) continue;
                const identityKey = identityKeyOf(elementClass);
                if (!identityKey) continue;
                // Keyed lower-case so a written `factions [ … ]` still matches (game lookup ignores case).
                const key = field.name.toLowerCase();
                const candidates = found.get(key) ?? found.set(key, []).get(key)!;
                if (!candidates.some((candidate) => candidate.elementClass === elementClass)) {
                    candidates.push({ elementClass, identityKey });
                }
            }
        }
    }
    return found;
})();

/** The identity-key value written in an entity element group, as a bare/quoted string. */
const idValueNodeOf = (element: AbstractNode, identityKey: string): ValueNode | undefined => {
    if (!isGroupNode(element)) return undefined;
    for (const member of element.elements) {
        if (isAssignmentNode(member) && member.left.name.toLowerCase() === identityKey.toLowerCase() && isValueNode(member.right)) {
            const value = member.right;
            if (value.valueType.type === 'String') return value;
        }
    }
    return undefined;
};

export interface EntityDeclaration {
    readonly elementClass: string;
    readonly id: string;
    /** The node to jump to for go-to-definition — an id value node, or a group-keyed member. */
    readonly node: AbstractNode;
    /** True for an `OtherIDs` legacy alias, which resolves references but is not the primary id. */
    readonly alias?: boolean;
}

/**
 * The GUI id classes whose instances mods also declare as loose named groups (`WindowsOnOff
 * { ToggleID = "windows_on_off" Style = … Choices [ … ] }`) that a `mod.rules` action then adds into
 * the game's collection list, a declaration site the `PartToggles [ … ]`-list harvest cannot see.
 * Keyed by the class's identity field, lowercased.
 */
const LOOSE_GUI_CLASSES: ReadonlyMap<string, string> = new Map([
    ['toggleid', 'Cosmoteer.Game.PartToggleGuiRules'],
    ['colorid', 'Cosmoteer.Game.PartColorGuiRules'],
    ['targeterid', 'Cosmoteer.Game.PartTargeterGuiRules'],
    ['triggerid', 'Cosmoteer.Game.PartTriggerGuiRules'],
]);

/**
 * Members only a GUI id declaration carries. A reference site never has them: a part references a
 * toggle inside a `Type = UIToggle` component (which the `Type` guard excludes anyway) or a
 * `ShowOnlyInToggleMode { ToggleID, Mode }` sprite gate, which has none of these.
 */
const GUI_DECLARATION_MEMBERS: ReadonlySet<string> = new Set([
    'style',
    'choices',
    'buttontooltipkey',
    'buttonsprite',
    'coloredsprite',
]);

/**
 * The GUI id declaration a loose group makes, or undefined. A group declares a GUI id when it writes
 * one of the identity fields as a string, carries a declaration-shape member, and has no `Type`
 * discriminator (a part component referencing the id always has one).
 */
const looseGuiDeclarationOf = (group: AbstractNode): EntityDeclaration | undefined => {
    if (!isGroupNode(group)) return undefined;
    let idNode: ValueNode | undefined;
    let elementClass: string | undefined;
    let hasShapeMember = false;
    for (const member of group.elements) {
        const name = isAssignmentNode(member)
            ? member.left.name
            : isGroupNode(member) || isListNode(member)
              ? member.identifier?.name
              : undefined;
        if (!name) continue;
        const lower = name.toLowerCase();
        if (lower === 'type') return undefined;
        if (GUI_DECLARATION_MEMBERS.has(lower)) hasShapeMember = true;
        const cls = LOOSE_GUI_CLASSES.get(lower);
        if (cls && isAssignmentNode(member) && isValueNode(member.right) && member.right.valueType.type === 'String') {
            idNode = member.right;
            elementClass = cls;
        }
    }
    if (!idNode || !elementClass || !hasShapeMember) return undefined;
    return { elementClass, id: String(idNode.valueType.value), node: idNode };
};

/**
 * Group-name-keyed entities: a `map<reference X, V>` collection writes each entity as a named member
 * whose name is the id (`buffs.rules` → `Engine { … }`, `part_features.rules` → `PartFeatures
 * { CanReceivePower = … }`). Yields one `(X, memberName, memberNode)` per named member of `container`.
 */
function* mapKeyedMembers(container: AbstractNode, elementClass: string): Generator<EntityDeclaration> {
    if (!isGroupNode(container) && !isDocumentNode(container)) return;
    for (const member of container.elements) {
        if ((isGroupNode(member) || isListNode(member)) && member.identifier) {
            yield { elementClass, id: member.identifier.name, node: member.identifier };
        } else if (isAssignmentNode(member)) {
            yield { elementClass, id: member.left.name, node: member.left };
        }
    }
}

/**
 * Every cross-file entity declared in `document`:
 *  - list-element entities (`Factions [ { ID } ]`, `PartToggles [ { ToggleID } ]`, …) — by field name;
 *  - group-name-keyed entities of a `map<reference X, V>` collection the document is (a whole-file map
 *    alias like `Buffs = &<buffs.rules>`) or holds as a top-level member (a member alias like
 *    `PartFeatures = &<part_features.rules>/PartFeatures`) — discovered via {@link aliasRootIndex}, so
 *    only the authoritative collections aliased from the game root count (never a per-object
 *    `map<reference X, scalar>` consumer field like `DamageResistances`).
 */
export function* entityDeclarationsOf(document: AbstractNodeDocument): Generator<EntityDeclaration> {
    function* visit(node: AbstractNode): Generator<EntityDeclaration> {
        if (isListNode(node) && node.identifier) {
            const candidates = ENTITY_FIELDS.get(node.identifier.name.toLowerCase());
            if (candidates) {
                for (const element of node.elements) {
                    // Index each element under every candidate class whose identity key it carries. A
                    // query then keeps only the subclass(es) of the reference's target.
                    for (const entity of candidates) {
                        const idNode = idValueNodeOf(element, entity.identityKey);
                        if (idNode) {
                            yield { elementClass: entity.elementClass, id: String(idNode.valueType.value), node: idNode };
                            yield* otherIdAliasesOf(element, entity.elementClass);
                        }
                    }
                }
            }
        }
        // A self-keyed map member (`RenderLayers`, `TradeShips`, …) declares its keys, in the named
        // (`RenderLayers [ … ]`) and assignment (`RenderLayers = [ … ]`) spellings alike.
        const selfKeyedMember = namedContainerOf(node);
        if (selfKeyedMember) {
            const selfKeyed = SELF_KEYED_MAP_FIELDS.get(selfKeyedMember.name.toLowerCase());
            if (selfKeyed) yield* selfKeyedMapDeclarationsOf(selfKeyedMember.container, selfKeyed);
        }
        // A part's `Stats { PowerUsage = … }` keys are the provider side of the stat relation: the
        // part writes the stat into existence and the GUI's stat entries and widgets reference it,
        // so each key declares the stat id.
        if (selfKeyedMember && isGroupNode(selfKeyedMember.container) && STAT_PROVIDER_FIELDS.has(selfKeyedMember.name.toLowerCase())) {
            for (const member of selfKeyedMember.container.elements) {
                if (isAssignmentNode(member)) yield { elementClass: PART_STAT_CLASS, id: member.left.name, node: member.left };
            }
        }
        // A damage effect's `DamageType = fire` declares the type, like a category: the resistance
        // maps reference whatever the hit effects deal (plus the engine's hardcoded three).
        if (
            isAssignmentNode(node) &&
            node.left.name.toLowerCase() === 'damagetype' &&
            isValueNode(node.right) &&
            node.right.valueType.type === 'String'
        ) {
            yield { elementClass: DAMAGE_TYPE_CLASS, id: String(node.right.valueType.value), node: node.right };
        }
        // A loose GUI id group a mod.rules action later adds into the game's collection.
        const loose = looseGuiDeclarationOf(node);
        if (loose) yield loose;
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) yield* visit(child);
    }
    for (const element of document.elements) yield* visit(element);

    // A part file's own identity, and a sysgen file's usage-defined spawner tags.
    yield* partDeclarationsOf(document);
    yield* spawnerTagDeclarationsOf(document);

    // Group-name-keyed entities, gated by the alias-root index (authoritative collections only).
    const rootType = aliasRootIndex.rootType(document.uri);
    if (rootType?.kind === 'map' && rootType.key.kind === 'reference') {
        yield* mapKeyedMembers(document, rootType.key.target);
    }
    for (const element of document.elements) {
        if ((isGroupNode(element) || isListNode(element)) && element.identifier) {
            const memberType = aliasRootIndex.memberType(document.uri, element.identifier.name);
            if (memberType?.kind === 'map' && memberType.key.kind === 'reference') {
                yield* mapKeyedMembers(element, memberType.key.target);
            }
        }
    }
}

/** True if `cls` is a class for which list-element entity declarations are tracked. */
export const isEntityClass = (cls: string): boolean => {
    for (const candidates of ENTITY_FIELDS.values()) {
        if (candidates.some((entity) => entity.elementClass === cls)) return true;
    }
    return false;
};

export const PART_RULES_CLASS = 'Cosmoteer.Ships.Parts.PartRules';
export const SIM_OBJECT_SPAWNER_CLASS = 'Cosmoteer.Generators.Simulation.SimObjectSpawner';
export const DAMAGE_TYPE_CLASS = 'Cosmoteer.DamageType';
export const PART_STAT_CLASS = 'Cosmoteer.Game.PartStatRules';

/**
 * Lower-cased names of the map fields whose keys write part stats into existence (`Stats`, decompile
 * verified: the build GUI reads whichever stat ids the parts provide). Derived from the schema as
 * every `map<reference PartStatRules, V>` field name.
 */
const STAT_PROVIDER_FIELDS: ReadonlySet<string> = (() => {
    const found = new Set<string>();
    for (const type of Object.values(schema.types)) {
        for (const field of type.fields) {
            const vt = field.valueType;
            if (vt.kind === 'map' && vt.key.kind === 'reference' && vt.key.target === PART_STAT_CLASS) {
                found.add(field.name.toLowerCase());
            }
        }
    }
    return found;
})();

/**
 * Ids the engine hardcodes in C#, so no file declares them: `DamageType`'s three static instances,
 * the sim-object tags the game modes register at runtime (`player`, `spawn_point`, …), the crew-job
 * component ids (`ConstructionTracker`, `SalvageJob`, …). Extracted by schemagen, which sweeps every
 * literal `new ID<T>("…")` construction in the game assemblies, so the set follows a game update
 * through a normal schema regeneration. The id index serves them alongside the file-harvested
 * declarations, for completion and for the existence checks alike.
 */
export const BUILTIN_IDS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries(schema.builtinIds ?? {}));

/**
 * Lower-cased field name → the key target class(es) of a `map<reference X, V>` field of that name
 * anywhere in the schema. Resolves `Key = …` references of the entry-list map spelling
 * (`RenderLayers [ { Key = "structure" Value { … } } ]`) when the entry's owner class is not
 * resolvable from context, mirroring how {@link ENTITY_FIELDS} keys on field names.
 */
export const REFERENCE_MAP_KEY_FIELDS: ReadonlyMap<string, readonly string[]> = (() => {
    const found = new Map<string, string[]>();
    for (const type of Object.values(schema.types)) {
        for (const field of type.fields) {
            const vt = field.valueType;
            if (vt.kind !== 'map' || vt.key.kind !== 'reference') continue;
            const key = field.name.toLowerCase();
            const targets = found.get(key) ?? found.set(key, []).get(key)!;
            if (!targets.includes(vt.key.target)) targets.push(vt.key.target);
        }
    }
    return found;
})();

/**
 * Lower-cased field name → the key target of a self-keyed map field (`map<reference X, group X>`),
 * whose member names and entry `Key`s declare the instances of X the keys reference (`RenderLayers`,
 * `TradeShips`, `Styles`, …). Only field names the schema uses exclusively as such maps qualify: the
 * harvest is name-driven and global, so a name that elsewhere means something else (a plain group, a
 * component list) would pollute the id pool with garbage declarations.
 */
export const SELF_KEYED_MAP_FIELDS: ReadonlyMap<string, string> = (() => {
    const candidates = new Map<string, Set<string>>();
    const disqualified = new Set<string>();
    for (const type of Object.values(schema.types)) {
        for (const field of type.fields) {
            const vt = field.valueType;
            const key = field.name.toLowerCase();
            if (vt.kind === 'map' && vt.key.kind === 'reference' && vt.value.kind === 'group' && vt.value.ref === vt.key.target) {
                (candidates.get(key) ?? candidates.set(key, new Set()).get(key)!).add(vt.key.target);
            } else {
                disqualified.add(key);
            }
        }
    }
    const found = new Map<string, string>();
    for (const [key, targets] of candidates) {
        if (!disqualified.has(key) && targets.size === 1) found.set(key, [...targets].pop()!);
    }
    return found;
})();

/** The named group/list a node declares, covering the named (`Foo { }` / `Foo [ ]`) and assignment
 *  (`Foo = { }` / `Foo = [ ]`) spellings, which the game reads identically. */
const namedContainerOf = (
    node: AbstractNode
): { name: string; container: AbstractNode } | undefined => {
    if ((isGroupNode(node) || isListNode(node)) && node.identifier) {
        return { name: node.identifier.name, container: node };
    }
    if (isAssignmentNode(node) && (isGroupNode(node.right) || isListNode(node.right))) {
        return { name: node.left.name, container: node.right };
    }
    return undefined;
};

/** The declarations a self-keyed map member makes: named members (group spelling) or entry `Key`s
 *  (`[{ Key = "x" Value { … } }]` list spelling), each an instance of the map's key target. */
function* selfKeyedMapDeclarationsOf(node: AbstractNode, target: string): Generator<EntityDeclaration> {
    if (isGroupNode(node)) {
        yield* mapKeyedMembers(node, target);
        return;
    }
    if (!isListNode(node)) return;
    for (const entry of node.elements) {
        if (!isGroupNode(entry)) continue;
        for (const member of entry.elements) {
            if (
                isAssignmentNode(member) &&
                member.left.name.toLowerCase() === 'key' &&
                isValueNode(member.right) &&
                member.right.valueType.type === 'String'
            ) {
                yield { elementClass: target, id: String(member.right.valueType.value), node: member.right };
            }
        }
    }
}

/** The alias ids an entity element declares beside its identity. The engine's `GetAllIDs()` registers
 *  the `ID` and every `OtherIDs` entry into the same lookup dictionary (decompile verified on parts,
 *  doors and ships alike), so each alias resolves references exactly like the primary id, e.g. the
 *  rock parts' `cosmoteer.rubble` aliases the asteroid doodads reference. */
function* otherIdAliasesOf(element: AbstractNode, elementClass: string): Generator<EntityDeclaration> {
    if (!isGroupNode(element)) return;
    for (const member of element.elements) {
        const named = namedContainerOf(member);
        if (named && named.name.toLowerCase() === 'otherids' && isListNode(named.container)) {
            for (const alias of named.container.elements) {
                if (isValueNode(alias) && alias.valueType.type === 'String') {
                    yield { elementClass, id: String(alias.valueType.value), node: alias, alias: true };
                }
            }
        }
    }
}

/** The part ids a top-level `Part { … }` group declares: its `ID = …` identity, plus every alias in
 *  its `OtherIDs = [ … ]` list. */
function* partDeclarationsOf(document: AbstractNodeDocument): Generator<EntityDeclaration> {
    for (const element of document.elements) {
        if (!isGroupNode(element) || element.identifier?.name.toLowerCase() !== 'part') continue;
        for (const member of element.elements) {
            if (
                isAssignmentNode(member) &&
                member.left.name.toLowerCase() === 'id' &&
                isValueNode(member.right) &&
                member.right.valueType.type === 'String'
            ) {
                yield { elementClass: PART_RULES_CLASS, id: String(member.right.valueType.value), node: member.right };
            }
        }
        yield* otherIdAliasesOf(element, PART_RULES_CLASS);
    }
}

/**
 * The spawner tags a document declares. A spawner has no `ID`: other spawners reference it by the
 * strings in its `Tags [ … ]` list (`MinDistanceFromTags`, `RootLocationTag`, …), so each written tag
 * is itself the declaration, like a part category. `Tags` is too generic a name to harvest blindly
 * (a ship spawner's `Criteria { Tags }` targets builtin-ship tags instead), so each candidate list is
 * checked through its resolved slot: a slot that resolves to anything other than a
 * `list<reference SimObjectSpawner>` is skipped. An unresolvable slot still harvests, because
 * template groups (`CapturedStation : UndiscoveredStation { Tags = … }`) carry their class only
 * through inheritance, which this sync walk cannot follow.
 */
function* spawnerTagDeclarationsOf(document: AbstractNodeDocument): Generator<EntityDeclaration> {
    function* visit(node: AbstractNode): Generator<EntityDeclaration> {
        const member = namedContainerOf(node);
        if (member && member.name.toLowerCase() === 'tags' && isListNode(member.container)) {
            const slot = listSlotType(member.container);
            const resolvedElsewhere =
                slot !== undefined &&
                !(
                    (slot.kind === 'list' || slot.kind === 'range' || slot.kind === 'interpolated') &&
                    slot.element.kind === 'reference' &&
                    slot.element.target === SIM_OBJECT_SPAWNER_CLASS
                );
            if (!resolvedElsewhere) {
                for (const element of member.container.elements) {
                    if (isValueNode(element) && element.valueType.type === 'String') {
                        yield { elementClass: SIM_OBJECT_SPAWNER_CLASS, id: String(element.valueType.value), node: element };
                    }
                }
            }
        }
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) yield* visit(child);
    }
    for (const element of document.elements) yield* visit(element);
}
