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
    ListNode,
    ValueNode,
} from '../../core/ast/ast';
import { fieldsOf, schema } from './schema';
import { ValueType } from './schema.types';
import { aliasRootIndex } from './alias-root';

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
                        if (idNode) yield { elementClass: entity.elementClass, id: String(idNode.valueType.value), node: idNode };
                    }
                }
            }
        }
        // A loose GUI id group a mod.rules action later adds into the game's collection.
        const loose = looseGuiDeclarationOf(node);
        if (loose) yield loose;
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? [node.right]
                  : [];
        for (const child of children) yield* visit(child);
    }
    for (const element of document.elements) yield* visit(element);

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
