import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { classOfGroup, registryForContainer, resolveGroupClass } from '../../document/schema/schema-context';
import { fieldOf, registryOf } from '../../document/schema/schema';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { ReverseIncludeIndex } from '../navigation/reverse-include.index';
import { isFile, FileWithPath } from '../../workspace/cosmoteer-workspace.service';
import { namedMembersOf, getStartOfAstNode } from '../../utils/ast.utils';
import { closestMatch } from '../../utils/did-you-mean';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

const navigation = new FullNavigationStrategy();

// A plain, single-segment identifier. Sibling `ID<…>` values are bare component names — anything with
// a `/`, `&`, `<`, math, or whitespace is a path/reference/expression we must not treat as a sibling id.
const PLAIN_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Component ids the engine injects at runtime: they are referenced in `.rules` (vanilla's
 * `GetColorFrom = ConstructionTracker`) but declared in no file, so existence cannot be judged.
 */
const RUNTIME_INJECTED_IDS: ReadonlySet<string> = new Set(['constructiontracker']);

/**
 * Schema `ID<…>` fields whose value is not a same-part component reference despite the type:
 *  - `OverridePriorityKey` is an opaque shared priority label (vanilla's `PartCrew` groups
 *    `PartCrew1..4` under one key that names no component),
 *  - `ChainFireToggleComponent` names a component of the part the beam chains into (vanilla's ion
 *    beam emitter references the prism's `IonBeamChainToggle`), so it resolves outside this part.
 */
const NON_SIBLING_FIELDS: ReadonlySet<string> = new Set(['overrideprioritykey', 'chainfiretogglecomponent']);

const isNode = (value: unknown): value is AbstractNode =>
    !!value && !isFile(value as FileWithPath) && typeof (value as AbstractNode).type === 'string';

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
 */
const collectComponentIds = async (
    document: AbstractNodeDocument,
    token: CancellationToken
): Promise<Set<string>> => {
    // One collection per parsed document: an edit produces a new AST (a new key), and this
    // document's diagnostics are only recomputed on its own edits anyway, so the union cannot be
    // observed stale. Without this, every validation of a part re-ran the cross-file BFS.
    const cached = componentIdsByDocument.get(document);
    if (cached) return cached;
    const collected = collectComponentIdsUncached(document, token).then((ids) => {
        // A cancelled walk returns a partial union. Serving that to a later validation would
        // false-positive, so drop it and let the next run collect fresh.
        if (token.isCancellationRequested) componentIdsByDocument.delete(document);
        return ids;
    });
    componentIdsByDocument.set(document, collected);
    return collected;
};

/** Per-AST memo of the part-wide component-id union (see {@link collectComponentIds}). */
const componentIdsByDocument: WeakMap<AbstractNodeDocument, Promise<Set<string>>> = new WeakMap();

/**
 * The uncached part-wide component-id collection behind {@link collectComponentIds}.
 *
 * @param document the part document whose component ids to union.
 * @param token cancels the cross-file walk.
 * @returns every reachable component id, lowercased.
 */
const collectComponentIdsUncached = async (
    document: AbstractNodeDocument,
    token: CancellationToken
): Promise<Set<string>> => {
    const ids = new Set<string>();
    const seenNodes = new Set<AbstractNode>();
    const seenRefs = new Set<string>();
    const queue: AbstractNode[] = [document];

    while (queue.length) {
        if (token.isCancellationRequested) break;
        const root = queue.pop();
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
                if (node.identifier?.name) ids.add(node.identifier.name.toLowerCase());
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
                    ids.add(node.left.name.toLowerCase());
                }
                // An include-valued components block (`Components = &<he/….rules>/Components`, the
                // mode-variant pattern of vanilla's missile launcher) merges the target's components
                // into this part, so their ids belong to the union just like an inherited base's.
                if (
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
                      ? [node.right]
                      : [];
            for (const child of children) stack.push(child);
        }
    }
    return ids;
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

    const componentIds = await collectComponentIds(document, cancellationToken);
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

            const field = fieldOf(cls, element.left.name);
            // Only a reference field whose target is the container's own registry is a component id.
            if (!field || field.valueType.kind !== 'reference' || registryOf(field.valueType.target) !== registry) {
                continue;
            }
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

    const visit = (node: AbstractNode): void => {
        if (cancellationToken.isCancellationRequested) return;
        if (isGroupNode(node)) checkGroup(node);
        const children: AbstractNode[] =
            isGroupNode(node) || isListNode(node) || isDocumentNode(node)
                ? node.elements
                : isAssignmentNode(node)
                  ? [node.right]
                  : [];
        for (const child of children) visit(child);
    };

    for (const element of document.elements) visit(element);
    return errors;
};

/**
 * True if `group` is a cross-part proxy: it declares `PartLocation` or `PartCriteria`, the fields a
 * proxy uses to name another cell's part, or it is a `Type = ChainableProxy`, which resolves its
 * `ComponentID` against whichever part is chained to this one (a solar panel spike's
 * `AnchorLocation` lives in the anchor part). Such a proxy's `ComponentID` targets a component in
 * that other part, so it must not be checked against this part's component ids.
 */
const targetsAnotherPart = (group: GroupNode): boolean =>
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

/** True if any group in the document has an assignment whose schema field is a same-container `ID<…>`. */
const hasCandidateSiblingReference = (document: AbstractNodeDocument): boolean => {
    let found = false;
    const visit = (node: AbstractNode): void => {
        if (found) return;
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
                        const field = fieldOf(cls, element.left.name);
                        if (field?.valueType.kind === 'reference' && registryOf(field.valueType.target) === registry) {
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
                  ? [node.right]
                  : [];
        for (const child of children) visit(child);
    };
    for (const element of document.elements) visit(element);
    return found;
};
