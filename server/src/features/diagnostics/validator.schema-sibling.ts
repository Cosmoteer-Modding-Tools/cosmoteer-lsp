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
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { classOfGroup, listSlotType, registryForContainer, resolveGroupClass } from '../../document/schema/schema-context';
import { fieldOf, registryOf, scalarReferenceTargetOf } from '../../document/schema/schema';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { ReverseIncludeIndex } from '../navigation/reverse-include.index';
import { componentReferenceIdOf } from '../navigation/schema-reference.navigation';
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

    // Only validate documents that are a complete part (a top-level `Part` group). A file with a
    // bare top-level `Components` is a fragment merged into a parent part elsewhere, so its component
    // ids resolve against that parent — checking it standalone would false-positive.
    if (!isCompletePart(document)) return [];

    // A file other files inherit from (`Derived : <this_file.rules>/Part/…`) is a template: its
    // references may name components only the deriving parts declare (a mod's `jump_wire_stuff.rules`
    // wires `OperationalToggle = LogicSignal` for a signal component each deriver brings). Standalone
    // existence cannot be judged there, so such files are skipped rather than false-positived.
    if (ReverseIncludeIndex.instance.inheritanceBaseMembers(document.uri).length > 0) return [];

    // Cheap pre-pass: only do the (cross-file) id collection if the document actually contains a
    // candidate sibling-reference field. Most files have none.
    if (!hasCandidateSiblingReference(document)) return [];

    const partComponentIds = await collectPartComponentIds(document, cancellationToken);
    const componentIds = partComponentIds.all;
    const errors: ValidationError[] = [];

    const checkGroup = (group: GroupNode): void => {
        const container = group.parent;
        if (!container || !isGroupNode(container)) return;
        // A cross-part proxy (a group declaring `PartLocation`/`PartCriteria`) resolves its component
        // ids (`ComponentID = LoadedAmmo`) against the adjacent targeted part rather than this one. A
        // railgun's `ResourceStorageProxy`, for example, reaches into the ammo part next to it. That
        // part is outside this document's scope, so its ids are absent from the part-wide union and a
        // check here would false-positive. The validator's contract is same-part references only, so
        // skip these groups.
        if (targetsAnotherPart(group)) return;
        const registry = registryForContainer(container);
        if (!registry) return;
        const cls = classOfGroup(group, registry.name) ?? resolveGroupClass(group);
        if (!cls) return;

        for (const element of group.elements) {
            if (cancellationToken.isCancellationRequested) return;
            if (!isAssignmentNode(element)) continue;
            if (NON_SIBLING_FIELDS.has(element.left.name.toLowerCase())) continue;
            const value = element.right;
            if (!isValueNode(value) || value.valueType.type !== 'String') continue;

            // Only a field targeting the container's own registry is a component id: a direct
            // reference, or a scalar-form group whose scalar payload is that reference
            // (`FireTrigger = Turret` reads into ComponentTriggerReferenceRules.ID).
            if (!isComponentField(cls, element.left.name, registry)) continue;
            const written = String(value.valueType.value);
            if (!PLAIN_ID.test(written)) continue;
            if (RUNTIME_INJECTED_IDS.has(written.toLowerCase())) continue;
            if (componentIds.has(written.toLowerCase())) continue;

            const siblings = namedMembersOf(container)
                .map(([name]) => name)
                .filter((name) => name !== group.identifier?.name);
            const suggestion = closestMatch(written, siblings, true);
            errors.push({
                message: l10n.t("No component named '{0}' in this part.", written),
                node: value,
                severity: 'warning',
                ...(suggestion
                    ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                    : {}),
            });
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

            const suggestion = closestMatch(written, [...partComponentIds.components.values()], true);
            errors.push({
                message: l10n.t("No component named '{0}' in this part.", written),
                node: element,
                severity: 'warning',
                ...(suggestion
                    ? { data: { quickFix: { title: l10n.t("Change to '{0}'", suggestion), newText: suggestion } } }
                    : {}),
            });
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

/** True if the document is a self-contained part: it has a top-level `Part` group. */
const isCompletePart = (document: AbstractNodeDocument): boolean =>
    document.elements.some((element) => isGroupNode(element) && element.identifier?.name === 'Part');

/** True if any group in the document has an assignment whose schema field is a same-container `ID<…>`,
 *  or any list holds a plain-id string in a part-component tuple slot. */
const hasCandidateSiblingReference = (document: AbstractNodeDocument): boolean => {
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
            const container = node.parent;
            const registry = container && isGroupNode(container) ? registryForContainer(container) : undefined;
            if (registry) {
                const cls = classOfGroup(node, registry.name) ?? resolveGroupClass(node);
                if (cls) {
                    for (const element of node.elements) {
                        if (!isAssignmentNode(element)) continue;
                        const value = element.right;
                        if (!isValueNode(value) || value.valueType.type !== 'String') continue;
                        if (!PLAIN_ID.test(String(value.valueType.value))) continue;
                        if (isComponentField(cls, element.left.name, registry)) {
                            found = true;
                            return;
                        }
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
