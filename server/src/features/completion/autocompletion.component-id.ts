import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, GroupNode, isDocumentNode, isGroupNode } from '../../core/ast/ast';
import { registryForGroup } from '../../document/schema/schema-context';
import { fieldOf, registryOf, scalarReferenceTargetOf } from '../../document/schema/schema';
import { namedMembersOf } from '../../utils/ast.utils';
import {
    collectPartComponentIds,
    NON_SIBLING_FIELDS,
    targetsAnotherPart,
} from '../diagnostics/validator.schema-sibling';
import { BUILTIN_IDS } from '../../document/schema/entity-schema';
import { Completion } from './autocompletion.service';

/** The registry whose ids the engine resolves part-wide (across nesting and inherited bases). */
const PART_COMPONENT_REGISTRY = 'PartComponentRules';

/** The document node an AST node belongs to, by walking its parent chain. */
const documentOf = (node: AbstractNode): AbstractNodeDocument | undefined => {
    let current: AbstractNode | undefined = node;
    while (current && !isDocumentNode(current)) current = current.parent;
    return current && isDocumentNode(current) ? current : undefined;
};

/**
 * Completions for a same-registry `ID<…>` component reference field (`OperationalToggle = …`,
 * `ComponentID = …`): the sibling components of the same container, plus every component declared
 * anywhere in the part for the part-component registry, whose ids the engine resolves part-wide.
 * That union includes inherited bases and include-merged `Components` blocks (the same cross-file
 * walk the sibling-reference validator checks existence against, so completion and validation agree).
 *
 * @param group the component group whose field value is being completed.
 * @param fieldName the field being assigned.
 * @param cls the group's resolved concrete class, if known.
 * @param cancellationToken cancels the cross-file component walk.
 * @returns the id completions, or undefined when the field is not a same-registry reference.
 */
export const componentIdCompletions = async (
    group: GroupNode,
    fieldName: string,
    cls: string | undefined,
    cancellationToken: CancellationToken
): Promise<Completion[] | undefined> => {
    const container = group.parent;
    if (!container || !isGroupNode(container) || !cls) return undefined;
    const registry = registryForGroup(group);
    if (!registry) return undefined;
    const field = fieldOf(cls, fieldName);
    // A same-registry reference field, or a scalar-form group field whose scalar payload is such a
    // reference (`FireTrigger = Turret` reads into ComponentTriggerReferenceRules.ID).
    const target =
        field?.valueType.kind === 'reference'
            ? field.valueType.target
            : field?.valueType.kind === 'group'
              ? scalarReferenceTargetOf(field.valueType.ref)
              : undefined;
    if (!target || registryOf(target) !== registry) return undefined;
    // Fields whose value resolves outside this part (an opaque priority key, a cross-part proxy's
    // target, a chained part's component) must not be fed this part's ids.
    if (NON_SIBLING_FIELDS.has(fieldName.toLowerCase())) return undefined;
    if (targetsAnotherPart(group)) return undefined;

    const self = group.identifier?.name.toLowerCase();
    const out = new Map<string, Completion>();
    for (const [name] of namedMembersOf(container)) {
        const lower = name.toLowerCase();
        if (lower === self || out.has(lower)) continue;
        out.set(lower, {
            label: name,
            kind: CompletionItemKind.Reference,
            detail: `${registry.name} (sibling)`,
            sortText: `0_${name}`,
        });
    }
    if (registry.name === PART_COMPONENT_REGISTRY) {
        const document = documentOf(group);
        if (document) {
            const partWide = await collectPartComponentIds(document, cancellationToken);
            for (const [lower, name] of partWide.components) {
                if (lower === self || out.has(lower)) continue;
                out.set(lower, {
                    label: name,
                    kind: CompletionItemKind.Reference,
                    detail: registry.name,
                    sortText: `1_${name}`,
                });
            }
        }
    }
    return [...out.values()];
};

/**
 * Part-wide component id completions for a reference target resolved outside a component group, e.g.
 * a tuple slot like a network router's `Routes [ [A, B, 0] ]`. The cross-file id index cannot serve
 * these (component ids are part-local, never project entities), so the caller tries this first.
 *
 * @param targetClass the reference target class the cursor position resolved to.
 * @param document the document being edited (the part whose components are in scope).
 * @param cancellationToken cancels the cross-file component walk.
 * @returns the part-wide component id completions, or undefined when the target is not the
 *          part-component registry.
 */
export const componentIdCompletionsForTarget = async (
    targetClass: string,
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<Completion[] | undefined> => {
    const registry = registryOf(targetClass);
    if (registry?.name !== PART_COMPONENT_REGISTRY) return undefined;
    const partWide = await collectPartComponentIds(document, cancellationToken);
    const out: Completion[] = [...partWide.components.values()].map((name) => ({
        label: name,
        kind: CompletionItemKind.Reference,
        detail: registry.name,
        sortText: `0_${name}`,
    }));
    out.push(...builtinComponentCompletions(partWide.components));
    return out;
};

/** Completions for the engine-injected component ids (`ConstructionTracker`, the crew jobs), sorted
 *  after the part's own components and skipping ids the part declares itself. */
const builtinComponentCompletions = (declared: ReadonlyMap<string, string>): Completion[] =>
    (BUILTIN_IDS.get('Cosmoteer.Ships.Parts.PartComponentRules') ?? [])
        .filter((id) => !declared.has(id.toLowerCase()))
        .map((id) => ({
            label: id,
            kind: CompletionItemKind.Reference,
            detail: `${PART_COMPONENT_REGISTRY} (built-in)`,
            sortText: `2_${id}`,
        }));
