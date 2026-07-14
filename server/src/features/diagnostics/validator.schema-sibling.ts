import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    ListNode,
    ValueNode,
    isValueNode,
} from '../../core/ast/ast';
import type { ValueType } from '../../document/schema/schema.types';
import { isModRules } from '../../document/document-kind';
import { documentRootClass } from '../../document/schema/document-root';
import { classOfGroup, listSlotType, registryForContainer, resolveGroupClass } from '../../document/schema/schema-context';
import { fieldOf, registryOf, scalarReferenceTargetOf } from '../../document/schema/schema';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { ReverseIncludeIndex } from '../navigation/reverse-include.index';
import { componentReferenceIdOf } from '../navigation/schema-reference.navigation';
import { isSameOrSubclass } from '../navigation/schema-id-reference.navigation';
import { BUILTIN_IDS } from '../../document/schema/entity-schema';
import { overrideTargetsOf } from '../../mod/override-sources';
import { isFile, FileWithPath } from '../../workspace/cosmoteer-workspace.service';
import { namedMembersOf, getStartOfAstNode } from '../../utils/ast.utils';
import { closestMatch } from '../../utils/did-you-mean';
import type { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

const navigation = new FullNavigationStrategy();

// A plain, single-segment identifier. Sibling `ID<…>` values are bare component names — anything with
// a `/`, `&`, `<`, math, or whitespace is a path/reference/expression we must not treat as a sibling id.
export const PLAIN_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Component ids the engine injects at runtime: they are referenced in `.rules` (vanilla's
 * `GetColorFrom = ConstructionTracker`) but declared in no file, so existence cannot be judged.
 * Schema-extracted: schemagen sweeps the game assemblies for literal `new ID<PartComponentRules>`
 * constructions (the crew-job components and trackers).
 */
export const RUNTIME_INJECTED_IDS: ReadonlySet<string> = new Set(
    (BUILTIN_IDS.get('Cosmoteer.Ships.Parts.PartComponentRules') ?? []).map((id) => id.toLowerCase())
);

/**
 * Schema `ID<…>` fields whose value is not a same-part component reference despite the type:
 *  - `OverridePriorityKey` is an opaque shared priority label (vanilla's `PartCrew` groups
 *    `PartCrew1..4` under one key that names no component),
 *  - `ChainFireToggleComponent` names a component of the part the beam chains into (vanilla's ion
 *    beam emitter references the prism's `IonBeamChainToggle`), so it resolves outside this part.
 */
export const NON_SIBLING_FIELDS: ReadonlySet<string> = new Set(['overrideprioritykey', 'chainfiretogglecomponent']);

const isNode = (value: unknown): value is AbstractNode =>
    !!value && !isFile(value as FileWithPath) && typeof (value as AbstractNode).type === 'string';

/** The part-wide component-id collection: the loose existence union plus the precise declarations. */
export interface PartComponentIds {
    /** Every reachable group/list identifier (and assignment-declared name), lowercased. This is the
     *  over-inclusive union the validator's false-positive-free existence test checks against. */
    readonly all: Set<string>;
    /** The actual component declarations, the named members of every reachable `Components`
     *  container, as lowercased id → the name as written, for completion labels. */
    readonly components: ReadonlyMap<string, string>;
    /** Lowercased id → the first declaring node the walk saw (own file first, then bases), for the
     *  part-wide go-to-definition of a reference the same-container search cannot resolve. */
    readonly declarations: ReadonlyMap<string, AbstractNode>;
}

/**
 * Every component id reachable from a part document: the identifier of every group/list anywhere in
 * the document's tree, unioned with the same for every base the document inherits from (transitively,
 * across files), lowercased.
 *
 * This mirrors how the engine resolves an `ID<PartComponent>` value (`OperationalToggle = IsOperational`):
 * a component id is looked up part-wide, so a reference deep in a nested sub-component can name a
 * component declared at the top of `Components` or in an inherited base part. Collecting the whole
 * union and checking membership is therefore the false-positive-free existence test, far safer than
 * any scope-walk, which the vanilla scan proved misses both nesting and cross-file inheritance.
 *
 * Alongside the union, the same walk records the precise component declarations (members of a
 * `Components` container) with their written case, which id completion offers as labels.
 */
export const collectPartComponentIds = async (
    document: AbstractNodeDocument,
    token: CancellationToken
): Promise<PartComponentIds> => {
    // One collection per parsed document per epoch: an edit to this document produces a new AST
    // (a new key), and an edit to another file the union folds in (an inherited base, an included
    // components block) bumps the epoch through the server's cross-file invalidation. Without the
    // memo, every validation of a part re-ran the cross-file BFS.
    const cached = componentIdsByDocument.get(document);
    if (cached && cached.epoch === componentIdEpoch) return cached.ids;
    const epoch = componentIdEpoch;
    const collected = collectComponentIdsUncached(document, token, true).then((ids) => {
        // A cancelled walk returns a partial union. Serving that to a later validation would
        // false-positive, so drop it and let the next run collect fresh.
        if (token.isCancellationRequested) componentIdsByDocument.delete(document);
        return ids;
    });
    componentIdsByDocument.set(document, { epoch, ids: collected });
    return collected;
};

/**
 * Like {@link collectPartComponentIds}, but without following include-valued `Components` blocks
 * (`Components = &<he/….rules>/Components`). Those merge a conditional component set, a
 * `ToggledComponents` mode active only when its toggle is, while inherited bases and override
 * targets merge unconditionally. The component-name completion subtracts this union from the
 * part's dangling references: an id a sibling mode set declares must still be suggested to a new
 * set, since each active set has to bring its own.
 *
 * @param document the part document whose unconditional ids to union.
 * @param token cancels the cross-file walk.
 * @returns the existence union and the component declarations, both keyed lowercased.
 */
export const collectUnconditionalComponentIds = async (
    document: AbstractNodeDocument,
    token: CancellationToken
): Promise<PartComponentIds> => {
    const cached = unconditionalIdsByDocument.get(document);
    if (cached && cached.epoch === componentIdEpoch) return cached.ids;
    const epoch = componentIdEpoch;
    const collected = collectComponentIdsUncached(document, token, false).then((ids) => {
        if (token.isCancellationRequested) unconditionalIdsByDocument.delete(document);
        return ids;
    });
    unconditionalIdsByDocument.set(document, { epoch, ids: collected });
    return collected;
};

/** Per-AST memo of the part-wide component-id union (see {@link collectPartComponentIds}). */
const componentIdsByDocument: WeakMap<AbstractNodeDocument, { epoch: number; ids: Promise<PartComponentIds> }> =
    new WeakMap();

/** Per-AST memo of the unconditional union (see {@link collectUnconditionalComponentIds}). */
const unconditionalIdsByDocument: WeakMap<AbstractNodeDocument, { epoch: number; ids: Promise<PartComponentIds> }> =
    new WeakMap();

/** Cross-file edits change what the union would collect without changing this document's AST, so
 *  the memo carries an epoch the server bumps whenever any other file may have changed. */
let componentIdEpoch = 0;

/** Starts a fresh memo epoch for the part-wide component-id unions after a cross-file change. */
export const invalidateComponentIdCache = (): void => {
    componentIdEpoch++;
};

/**
 * The uncached part-wide component-id collection behind {@link collectPartComponentIds}.
 *
 * @param document the part document whose component ids to union.
 * @param token cancels the cross-file walk.
 * @param followComponentsIncludes whether include-valued `Components` blocks join the union (the
 *        validator's full existence union) or are skipped as conditional sets (the completion's
 *        unconditional union).
 * @returns the existence union and the component declarations, both keyed lowercased.
 */
const collectComponentIdsUncached = async (
    document: AbstractNodeDocument,
    token: CancellationToken,
    followComponentsIncludes: boolean
): Promise<PartComponentIds> => {
    const ids = new Set<string>();
    const components = new Map<string, string>();
    const declarations = new Map<string, AbstractNode>();
    const seenNodes = new Set<AbstractNode>();
    const seenRefs = new Set<string>();
    const queue: AbstractNode[] = [document];

    // A sparse override-patch file merges into a vanilla part at runtime (a manifest action pairs
    // `OverrideIn = <vanilla part>` with `Overrides = &<this file>`), so its component references
    // resolve against the merged result. The override target joins the union like an inherited base.
    for (const target of await overrideTargetsOf(document.uri, token).catch(() => [])) queue.push(target);

    // A `Components` container's named members are the part's actual component declarations: named
    // group/list members, plus assignment-form (`X = { … }`) and reference-form (`X = &…`) members,
    // which the engine treats identically to the brace form.
    const recordComponentsOf = (container: { elements: AbstractNode[] }): void => {
        for (const member of container.elements) {
            const name =
                (isGroupNode(member) || isListNode(member)) && member.identifier
                    ? member.identifier.name
                    : isAssignmentNode(member) &&
                        (isGroupNode(member.right) ||
                            isListNode(member.right) ||
                            (isValueNode(member.right) && member.right.valueType.type === 'Reference'))
                      ? member.left.name
                      : undefined;
            if (name && !components.has(name.toLowerCase())) components.set(name.toLowerCase(), name);
        }
    };

    while (queue.length) {
        if (token.isCancellationRequested) break;
        // First-in-first-out, so the document's own subtree records its declarations before any
        // queued base or override target does (the `declarations` map keeps the first node per id).
        const root = queue.shift();
        if (!root || seenNodes.has(root)) continue;
        seenNodes.add(root);

        // Walk this root's whole subtree: record group/list ids and resolve any inheritance refs,
        // pushing each resolved base node onto the queue so its subtree (and its own inheritance) is
        // folded in too. Depth is bounded by `seenNodes`/`seenRefs`, so cyclic inheritance terminates.
        const stack: AbstractNode[] = [root];
        while (stack.length) {
            if (token.isCancellationRequested) break;
            const node = stack.pop()!;
            if (isGroupNode(node) || isListNode(node)) {
                if (node.identifier?.name) {
                    const lower = node.identifier.name.toLowerCase();
                    ids.add(lower);
                    if (!declarations.has(lower)) declarations.set(lower, node);
                    if (lower === 'components') recordComponentsOf(node);
                }
                for (const inheritance of node.inheritance ?? []) {
                    if (inheritance.valueType.type !== 'Reference') continue;
                    const ref = inheritance.valueType.value;
                    if (seenRefs.has(ref)) continue;
                    seenRefs.add(ref);
                    const target = await navigation
                        .navigate(ref, inheritance, getStartOfAstNode(node).uri, token)
                        .catch(() => null);
                    if (isNode(target)) queue.push(target);
                }
            }
            if (isAssignmentNode(node)) {
                // An assignment-form component (`PowerToggle = { Type = UIToggle … }`) declares an id
                // exactly like the brace form, since the engine treats `X = { }` and `X { }` the same.
                // A reference-valued assignment (`LightHighToggle = &<roof_light.rules>/…/LightHighToggle`,
                // `BeerMug10 = &~/Part/BeerMug`) also declares its name: the engine copies the referenced
                // group in under that name. The value need not resolve here, the name alone is the id.
                if (
                    isGroupNode(node.right) ||
                    isListNode(node.right) ||
                    (isValueNode(node.right) && node.right.valueType.type === 'Reference')
                ) {
                    const lower = node.left.name.toLowerCase();
                    ids.add(lower);
                    if (!declarations.has(lower)) declarations.set(lower, node.left);
                }
                // An include-valued components block (`Components = &<he/….rules>/Components`, the
                // mode-variant pattern of vanilla's missile launcher) merges the target's components
                // into this part, so their ids belong to the union just like an inherited base's.
                if (
                    followComponentsIncludes &&
                    node.left.name.toLowerCase() === 'components' &&
                    isValueNode(node.right) &&
                    node.right.valueType.type === 'Reference'
                ) {
                    const ref = node.right.valueType.value;
                    if (!seenRefs.has(ref)) {
                        seenRefs.add(ref);
                        const target = await navigation
                            .navigate(ref, node.right, getStartOfAstNode(node).uri, token)
                            .catch(() => null);
                        if (isNode(target)) queue.push(target);
                    }
                }
            }
            const children: AbstractNode[] =
                isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                    ? node.elements
                    : isAssignmentNode(node)
                      ? (node.right ? [node.right] : [])
                      : [];
            for (const child of children) stack.push(child);
        }
    }
    return { all: ids, components, declarations };
};

/**
 * Resolves a component `ID<…>` reference to its declaring node part-wide: across nesting, inherited
 * bases and override targets, the same scope the existence validation and completion use. The async
 * complement to the same-file `resolveSchemaSiblingReference`, for go-to-definition of a reference
 * whose component lives in another file.
 *
 * @param node the value node under the cursor.
 * @param token cancels the cross-file walk.
 * @returns the declaring node, or undefined when the node is no component reference or nothing
 *          part-wide declares the id.
 */
export const resolvePartComponentDeclaration = async (
    node: AbstractNode | null | undefined,
    token: CancellationToken
): Promise<AbstractNode | undefined> => {
    const id = componentReferenceIdOf(node);
    if (id === undefined) return undefined;
    let root: AbstractNode | undefined = node!;
    while (root.parent) root = root.parent;
    if (!isDocumentNode(root)) return undefined;
    const partIds = await collectPartComponentIds(root, token);
    return partIds.declarations.get(id.toLowerCase());
};

/**
 * Validate schema `ID<…>` sibling references — a field like `OperationalToggle = IsOperational` whose
 * value names a component in the same part — flagging a value that names no component anywhere in the
 * part (a typo'd or stale component id).
 *
 * Conservative, to stay false-positive-free on real mods (the bar the other schema validators meet):
 *  - Only same-part component references are checked (the field's reference target registry is the one
 *    the container holds). Cross-file `ID<…>` targets (resources, etc.) are not validated here.
 *  - Existence is membership in the part-wide id set (see {@link collectComponentIds}): every id
 *    declared anywhere in this document or any inherited base. A value is flagged only when it is
 *    absent from that whole union.
 *  - Only bare single-identifier values are considered; references/paths/expressions are skipped.
 */
export const validateSchemaSiblingReferences = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];

    // Only validate documents that own a complete component set (a part, a bullet). A file with a
    // bare top-level `Components` is a fragment merged into a parent owner elsewhere, so its component
    // ids resolve against that parent, and checking it standalone would false-positive.
    const componentRegistry = ownerComponentRegistryOf(document);
    if (!componentRegistry) return [];

    // A file other files inherit from (`Derived : <this_file.rules>/Part/…`) is a template: its
    // references may name components only the deriving parts declare (a mod's `jump_wire_stuff.rules`
    // wires `OperationalToggle = LogicSignal` for a signal component each deriver brings). Standalone
    // existence cannot be judged there, so such files are skipped rather than false-positived.
    if (ReverseIncludeIndex.instance.inheritanceBaseMembers(document.uri).length > 0) return [];

    // Cheap pre-pass: only do the (cross-file) id collection if the document actually contains a
    // candidate sibling-reference field. Most files have none.
    if (!hasCandidateSiblingReference(document, componentRegistry)) return [];

    const partComponentIds = await collectPartComponentIds(document, cancellationToken);
    const componentIds = partComponentIds.all;
    const errors: ValidationError[] = [];
    // A bullet owns its components exactly like a part does, so only the wording differs.
    const ownerIsBullet = componentRegistry !== 'PartComponentRules';

    const flag = (value: ValueNode, written: string): void => {
        const suggestion = closestMatch(written, [...partComponentIds.components.values()], true);
        errors.push({
            message: ownerIsBullet
                ? l10n.t("No component named '{0}' in this bullet.", written)
                : l10n.t("No component named '{0}' in this part.", written),
            node: value,
            severity: 'warning',
            ...(suggestion
                ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                : {}),
        });
    };

    const checkGroup = (group: GroupNode): void => {
        const cls = classOfPartGroup(group);
        if (!cls) return;
        // A group that resolves its ids against another part cannot be judged against this one, so
        // its references are skipped rather than false-positived (see {@link reachesOutsideThisOwner}).
        if (reachesOutsideThisOwner(group)) return;

        for (const [fieldName, value] of componentFieldValuesOf(group, cls, componentRegistry)) {
            if (cancellationToken.isCancellationRequested) return;
            if (NON_SIBLING_FIELDS.has(fieldName.toLowerCase())) continue;
            const written = String(value.valueType.value);
            if (!PLAIN_ID.test(written)) continue;
            if (RUNTIME_INJECTED_IDS.has(written.toLowerCase())) continue;
            if (componentIds.has(written.toLowerCase())) continue;
            flag(value, written);
        }
    };

    // Component ids written in tuple slots (a network router's `Routes [ [from, to, cost] ]`): the
    // engine resolves them part-wide like any other component id, so absence from the union is the
    // same false-positive-free existence test the assignment form uses.
    const checkTupleList = (list: ListNode): void => {
        if (list.inheritance?.length) return;
        for (const [index, element] of list.elements.entries()) {
            if (cancellationToken.isCancellationRequested) return;
            if (!isValueNode(element) || element.valueType.type !== 'String') continue;
            if (!tupleComponentTargetAt(list, index)) continue;
            const written = String(element.valueType.value);
            if (!PLAIN_ID.test(written)) continue;
            if (RUNTIME_INJECTED_IDS.has(written.toLowerCase())) continue;
            if (componentIds.has(written.toLowerCase())) continue;
            flag(element, written);
        }
    };

    const visit = (node: AbstractNode): void => {
        if (cancellationToken.isCancellationRequested) return;
        if (isGroupNode(node)) checkGroup(node);
        if (isListNode(node)) checkTupleList(node);
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? (node.right ? [node.right] : [])
                  : [];
        for (const child of children) visit(child);
    };

    for (const element of document.elements) visit(element);
    return errors;
};

/**
 * Whether `fieldName` of class `cls` holds a component id of the container's own registry, either
 * as a direct reference field or as a scalar-form group whose scalar payload is that reference
 * (`FireTrigger = Turret` reads into ComponentTriggerReferenceRules.ID).
 *
 * @param cls the declaring class FullName.
 * @param fieldName the field being assigned.
 * @param registry the registry the container holds.
 * @returns true when a bare value of the field names a component of that registry.
 */
export const isComponentField = (cls: string, fieldName: string, registry: ReturnType<typeof registryOf>): boolean => {
    const field = fieldOf(cls, fieldName);
    const target =
        field?.valueType.kind === 'reference'
            ? field.valueType.target
            : field?.valueType.kind === 'group'
              ? scalarReferenceTargetOf(field.valueType.ref)
              : undefined;
    return !!target && registryOf(target) === registry;
};

/**
 * The component class a field of `cls` names, whatever shape it is written in: a direct reference
 * (`OperationalToggle = IsOperational`), a scalar-form group whose payload is that reference
 * (`FireTrigger = Turret` reads into ComponentTriggerReferenceRules.ID), or a list of either
 * (`ResourceCheckEmitters [ Emitter1, Emitter2 ]`).
 *
 * Reading the target off the schema field rather than off the container's registry is what lets the
 * check reach component references written outside a component group: a weapon's nested
 * `ResourceUsage { ResourceStorage = … }`, a route generator's `ComponentIDs`, the part's own
 * `SignificanceToggle`. The container-registry gate of {@link isComponentField} sees none of those,
 * because the enclosing container holds no component registry.
 *
 * @param cls the declaring class FullName.
 * @param fieldName the field being written.
 * @returns the referenced component class FullName, or undefined when the field names no component.
 */
export const componentTargetOfField = (cls: string, fieldName: string): string | undefined => {
    const valueType = fieldOf(cls, fieldName)?.valueType;
    const targetOf = (type: ValueType | undefined): string | undefined =>
        type?.kind === 'reference'
            ? type.target
            : type?.kind === 'group'
              ? scalarReferenceTargetOf(type.ref)
              : undefined;
    return valueType?.kind === 'list' ? targetOf(valueType.element) : targetOf(valueType);
};

/** The class of a buff-mediated component proxy, the `ViaBuffs { … }` group (see {@link reachesOutsideThisOwner}). */
const BUFF_PROXY_CLASS = 'Cosmoteer.Ships.Parts.Logic.BuffMultiProxyRules';

/**
 * True when `group` resolves its component ids against some other part than the one it is written
 * in, so this part's ids cannot judge them. Every mechanism the engine has for that is structural,
 * and this is the full set:
 *  - a proxy naming another cell's part, through `PartLocation` or `PartCriteria` (a railgun's
 *    `ResourceStorageProxy` reaching into the ammo part beside it),
 *  - a `Type = ChainableProxy`, which resolves against whichever part is chained to this one (a
 *    solar panel spike's `AnchorLocation` lives in the anchor part),
 *  - a `ViaBuffs { ComponentID = … }` group, which names a component of whichever part provides the
 *    buff (an arc mod's `TransformerArcEnergyStorage` lives in the transformer part). The group is
 *    typed {@link BUFF_PROXY_CLASS} by the schema, so this needs no field-name list.
 * The walk goes up to the owner, so a helper group nested inside such a proxy is covered too.
 */
const reachesOutsideThisOwner = (group: GroupNode): boolean => {
    for (let node: AbstractNode | undefined = group; node; node = node.parent) {
        if (!isGroupNode(node)) continue;
        if (targetsAnotherPart(node)) return true;
        const cls = resolveGroupClass(node);
        if (cls && isSameOrSubclass(cls, BUFF_PROXY_CLASS)) return true;
    }
    return false;
};

/** True when tuple slot `index` of `list`'s declared type is a part-component reference. */
export const tupleComponentTargetAt = (list: ListNode, index: number): boolean => {
    const slot = listSlotType(list);
    if (slot?.kind !== 'tuple') return false;
    const element = slot.elements[index];
    return element?.kind === 'reference' && registryOf(element.target)?.name === 'PartComponentRules';
};

/**
 * True if `group` is a cross-part proxy: it declares `PartLocation` or `PartCriteria`, the fields a
 * proxy uses to name another cell's part, or it is a `Type = ChainableProxy`, which resolves its
 * `ComponentID` against whichever part is chained to this one (a solar panel spike's
 * `AnchorLocation` lives in the anchor part). Such a proxy's `ComponentID` targets a component in
 * that other part, so it must not be checked against this part's component ids.
 */
export const targetsAnotherPart = (group: GroupNode): boolean =>
    group.elements.some((element) => {
        if (isAssignmentNode(element)) {
            if (element.left.name === 'PartLocation' || element.left.name === 'PartCriteria') return true;
            return (
                element.left.name === 'Type' &&
                isValueNode(element.right) &&
                String(element.right.valueType.value) === 'ChainableProxy'
            );
        }
        return isGroupNode(element) && (element.identifier?.name === 'PartLocation' || element.identifier?.name === 'PartCriteria');
    });

/** The class of a whole-file bullet root, whose `Components` are named per bullet exactly like a part's. */
const BULLET_RULES_CLASS = 'Cosmoteer.Bullets.BulletRules';

/**
 * The registry of the components a document owns, which is also the only registry whose ids its
 * references may name: `PartComponentRules` for a self-contained part (a top-level `Part` group),
 * `BulletComponentRules` for a whole-file bullet root (a shot file, which carries its `Components`
 * at the top level and roots as {@link BULLET_RULES_CLASS}).
 *
 * A bullet names its components exactly like a part does: the engine assigns each component's id
 * from its node name inside the owner's `Components` map, so the same owner-local check applies. It
 * is the only check those references get, since they are barred from the global id validator
 * precisely because they are owner-local (one bullet's `DamagePool` must not vouch for another's).
 *
 * A fragment (a bare top-level `Components` merged into an owner elsewhere) owns no complete set:
 * its ids resolve against the parent, so judging it standalone would false-positive.
 *
 * @param document the document to classify.
 * @returns the owned component registry name, or undefined when the document owns no component set.
 */
const ownerComponentRegistryOf = (document: AbstractNodeDocument): string | undefined => {
    if (document.elements.some((element) => isGroupNode(element) && element.identifier?.name === 'Part')) {
        return 'PartComponentRules';
    }
    const rootClass = documentRootClass(document);
    return rootClass && isSameOrSubclass(rootClass, BULLET_RULES_CLASS) ? 'BulletComponentRules' : undefined;
};

/** The class of a group inside an owner document: the registry-hinted class when the group sits in a
 *  polymorphic container (a component in `Components`), else its slot-driven class (a nested helper
 *  group, the `Part` group itself). */
const classOfPartGroup = (group: GroupNode): string | undefined => {
    const container = group.parent;
    const registry = container && isGroupNode(container) ? registryForContainer(container) : undefined;
    return (registry ? classOfGroup(group, registry.name) : undefined) ?? resolveGroupClass(group);
};

/**
 * Every value node of `group` written for a field that names a component of `registry`, in each
 * shape the engine accepts: the scalar (`OperationalToggle = IsOperational`), the assignment-form
 * list (`ResourceCheckEmitters = [A, B]`) and the brace-form list (`ResourceCheckEmitters [ A, B ]`).
 *
 * @param group the group whose fields to read.
 * @param cls the group's class FullName.
 * @param registry the owner's component registry, the only one whose ids resolve here.
 * @returns a generator of the field name and the value node written for it.
 */
function* componentFieldValuesOf(group: GroupNode, cls: string, registry: string): Generator<[string, ValueNode]> {
    const names = (fieldName: string): boolean => {
        const target = componentTargetOfField(cls, fieldName);
        return !!target && registryOf(target)?.name === registry;
    };
    const strings = function* (nodes: AbstractNode[]): Generator<ValueNode> {
        for (const node of nodes) if (isValueNode(node) && node.valueType.type === 'String') yield node;
    };
    for (const element of group.elements) {
        if (isAssignmentNode(element)) {
            if (!names(element.left.name)) continue;
            const right = element.right;
            const values = isListNode(right) ? [...strings(right.elements)] : [...strings(right ? [right] : [])];
            for (const value of values) yield [element.left.name, value];
        } else if (isListNode(element) && element.identifier && names(element.identifier.name)) {
            for (const value of strings(element.elements)) yield [element.identifier.name, value];
        }
    }
}

/** True if any group in the document writes a plain id for a field naming a component of `registry`,
 *  or any list holds a plain-id string in a component tuple slot. The cheap pre-pass that keeps the
 *  cross-file id collection off the files that have no component reference at all. */
const hasCandidateSiblingReference = (document: AbstractNodeDocument, registry: string): boolean => {
    let found = false;
    const visit = (node: AbstractNode): void => {
        if (found) return;
        if (isListNode(node) && !node.inheritance?.length) {
            for (const [index, element] of node.elements.entries()) {
                if (!isValueNode(element) || element.valueType.type !== 'String') continue;
                if (!PLAIN_ID.test(String(element.valueType.value))) continue;
                if (tupleComponentTargetAt(node, index)) {
                    found = true;
                    return;
                }
            }
        }
        if (isGroupNode(node)) {
            const cls = classOfPartGroup(node);
            if (cls) {
                for (const [, value] of componentFieldValuesOf(node, cls, registry)) {
                    if (PLAIN_ID.test(String(value.valueType.value))) {
                        found = true;
                        return;
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
        for (const child of children) visit(child);
    };
    for (const element of document.elements) visit(element);
    return found;
};
