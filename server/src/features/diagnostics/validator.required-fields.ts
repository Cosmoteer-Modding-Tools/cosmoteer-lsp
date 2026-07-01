import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { namedMembersOf, getStartOfAstNode } from '../../utils/ast.utils';
import {
    groupDiscriminator,
    registryForGroup,
    registryHintFromContainer,
    resolveGroupClass,
} from '../../document/schema/schema-context';
import { discriminatorIsAmbiguous, fieldsOf } from '../../document/schema/schema';
import { SchemaField } from '../../document/schema/schema.types';
import { DefinitionService } from '../navigation/definition.service';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { ValidationError } from './validator';
import { inheritanceBaseLeafName } from '../../utils/reference.utils';
import * as l10n from '@vscode/l10n';

/**
 * Whole-document pass (default on, settable off): flag a group that is missing a schema-required field.
 *
 * This is the false-positive-hard sibling of {@link validateSchema}. Cosmoteer leans heavily on
 * inheritance and runtime injection, so a naive "field absent ⇒ error" produces noise. The check is
 * therefore deliberately narrow and only fires when it is certain the field is genuinely absent:
 *
 *   - Only a polymorphic component instance whose registry is confidently inferred from its container
 *     (`Type = TurretWeapon` inside a `Components` slot) is considered. Requiring the container registry
 *     (not just the group's own `Type=`) excludes the part root (`PartRules`, ~34 inheritance-heavy
 *     required fields) and a top-level group whose bare discriminator merely coincides with a registry
 *     it is not in (a beam shot file's `Type = Beam` root is not the `BeamEffectRules` that selects).
 *     The document root and plain lists are likewise not checked.
 *   - A field counts as present if the group declares it directly, under one of its schema aliases, or
 *     anywhere up its (fully resolvable) inheritance chain.
 *   - Inheritance guard: if any inheritance reference on the group or a resolved ancestor does not
 *     resolve (a base in the unindexed vanilla install, a cross-file base the project has not loaded),
 *     the group is skipped entirely, since the missing field may be supplied by that unseen base.
 *   - Template skip: a group whose name is used as an inheritance base, anywhere in this document, or
 *     (via the {@link TemplateBaseIndex} `workspaceBaseNames` set) anywhere in the project, is a
 *     template completed by its deriving groups, never instantiated on its own, so it is not checked.
 *     Unlike the allowlist this also covers a mod's own `BASE_*` templates.
 *   - `~`-rooted bases and runtime/unresolvable inheritance skip the group (see the guard above).
 *   - mod.rules manifests are skipped (they are actions, not instances).
 *
 * Validated to zero false positives across all of vanilla (954 files) and 42 real workshop mods (7820
 * files): the schema's `optional` flag is now derived from real C# signals (explicit `Optional`,
 * constructor defaults, nullable annotation, inline empty alias, collection types, see `tools/schemagen`);
 * the workspace template index absorbs the cross-file `BASE_*` bases; and {@link RUNTIME_REQUIRED_ALLOWLIST}
 * covers the one class a spawner injects in code. Default on, can be turned off to skip the one-time
 * project index build (the only remaining cost, not a correctness concern).
 */

/**
 * `class FullName` → required field names whose absence from the `.rules` text is not an error because
 * the field is genuinely runtime-injected: a spawner/context sets it in engine code, leaving no static
 * trace anywhere (a nebula doodad's `ID`/`NebulaID`/`CategoryKey` are written by its spawner, never in
 * the doodad block). This is the only residue of the vanilla scan that no static signal can close,
 * since cross-file template bases are handled structurally by the template-base index, not here.
 */
const RUNTIME_REQUIRED_ALLOWLIST: Record<string, ReadonlySet<string>> = {
    'Cosmoteer.Simulation.Doodads.NebulaDoodadRules': new Set(['ID', 'NebulaID', 'CategoryKey']),
};

export const validateRequiredFields = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken,
    /**
     * Names used as an inheritance base elsewhere in the project (from {@link TemplateBaseIndex}). A
     * group with such a name is a cross-file template, completed by deriving groups in other files, so
     * it is skipped. Omitted (single-file mode) the check still catches same-file templates below.
     */
    workspaceBaseNames?: ReadonlySet<string>
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];

    const groups: GroupNode[] = [];
    // Names used as an inheritance base anywhere in this document (`Floor : BASE_SPRITES` →
    // `BASE_SPRITES`). A group with such a name is a template: its deriving groups complete its
    // required fields, and it is never instantiated on its own, so checking it would false-positive on
    // the vanilla `BASE_*` pattern. This works for a mod's own templates too, unlike a fixed allowlist.
    // The optional `workspaceBaseNames` adds the cross-file bases a single file cannot see.
    const inheritedBaseNames = new Set<string>();
    const collect = (node: AbstractNode): void => {
        if (isGroupNode(node) || isListNode(node)) {
            for (const reference of node.inheritance ?? []) {
                if (!isValueNode(reference) || reference.valueType.type !== 'Reference') continue;
                const leaf = inheritanceBaseLeafName(reference.valueType.value);
                if (leaf) inheritedBaseNames.add(leaf);
            }
        }
        if (isGroupNode(node)) {
            // Only a polymorphic component instance whose registry is confidently inferred from its
            // container (the slot's field type, or a valid sibling's `Type`). Requiring the container
            // registry (not merely the group's own `Type=`) excludes a top-level group whose bare
            // discriminator coincidentally matches a registry it does not belong to (e.g. a beam shot
            // file's `Type = Beam` root, which is not the `BeamEffectRules` that discriminator selects),
            // and the convention/slot-classified part root. Skip an unresolvable cross-registry ambiguity.
            const disc = groupDiscriminator(node);
            const unresolvableAmbiguity = disc && discriminatorIsAmbiguous(disc) && !registryHintFromContainer(node);
            if (disc && !unresolvableAmbiguity && registryForGroup(node) && resolveGroupClass(node)) {
                groups.push(node);
            }
        }
        const children = isGroupNode(node) || isListNode(node) || isDocumentNode(node)
            ? node.elements
            : isAssignmentNode(node)
              ? [node.right]
              : [];
        for (const child of children) collect(child);
    };
    for (const element of document.elements) collect(element);

    for (const group of groups) {
        if (cancellationToken.isCancellationRequested) break;
        // A template base completed by its deriving groups (same file or, via the workspace index,
        // another file), not an instance, so not checked.
        const name = group.identifier?.name;
        if (name && (inheritedBaseNames.has(name) || workspaceBaseNames?.has(name))) continue;
        const cls = resolveGroupClass(group);
        if (!cls) continue;
        const required = fieldsOf(cls).filter((field) => !field.optional);
        if (required.length === 0) continue;

        const present = new Set(namedMembersOf(group).map(([name]) => name));
        const ancestry = await gatherInheritedNames(group, cancellationToken);
        // A base we cannot see might supply the field, so stay silent rather than guess.
        if (!ancestry.fullyResolved) continue;
        for (const name of ancestry.names) present.add(name);

        const runtimeProvided = RUNTIME_REQUIRED_ALLOWLIST[cls];
        for (const field of required) {
            if (isSatisfied(field, present) || runtimeProvided?.has(field.name)) continue;
            errors.push({
                message: l10n.t("Missing required field '{0}' on {1}.", field.name, shortName(cls)),
                node: group.identifier ?? group,
                severity: 'warning',
            });
        }
    }
    return errors;
};

/** A required field is satisfied if it, or any of its aliases, is among the present member names. */
const isSatisfied = (field: SchemaField, present: Set<string>): boolean =>
    present.has(field.name) || (field.aliases?.some((alias) => present.has(alias)) ?? false);

/**
 * Collect every member name reachable up a group's inheritance chain, and whether the chain resolved
 * in full. `fullyResolved` is false the moment any inheritance reference fails to resolve (an unseen
 * base), which the caller treats as "cannot judge" and skips.
 */
const gatherInheritedNames = async (
    group: GroupNode | ListNode,
    cancellationToken: CancellationToken,
    visited = new Set<AbstractNode>()
): Promise<{ names: Set<string>; fullyResolved: boolean }> => {
    const names = new Set<string>();
    let fullyResolved = true;
    if (visited.has(group)) return { names, fullyResolved };
    visited.add(group);

    const document = getStartOfAstNode(group);
    for (const reference of group.inheritance ?? []) {
        if (cancellationToken.isCancellationRequested) return { names, fullyResolved: false };
        if (!isValueNode(reference) || reference.valueType.type !== 'Reference') continue;
        // A `~`-rooted base (`~/OVERCLOCK/BEAM`, `&~/…`) is a runtime template assembled where the rule
        // is instantiated, not knowable statically. Treat it as unresolved so the group is skipped
        // (its fields may come from that template), matching the runtime-root handling in reference
        // validation.
        const refValue = reference.valueType.value;
        if ((refValue.startsWith('&') ? refValue.slice(1) : refValue).startsWith('~')) {
            fullyResolved = false;
            continue;
        }
        const target = await DefinitionService.instance
            .resolveReferenceTarget(document, reference, cancellationToken)
            .catch(() => null);
        if (!target || isFile(target as FileWithPath)) {
            fullyResolved = false;
            continue;
        }
        const base = target as AbstractNode;
        // A base can be a group, a list, or a whole file (`: <…/walls.rules>` inherits the file's root
        // members), all of which expose `.elements`, so gather named members from any of them.
        if (isGroupNode(base) || isListNode(base) || isDocumentNode(base)) {
            for (const [name] of namedMembersOf(base)) names.add(name);
        }
        // Only a group/list carries its own `.inheritance` to recurse into (a document root has none).
        if (isGroupNode(base) || isListNode(base)) {
            const deeper = await gatherInheritedNames(base, cancellationToken, visited);
            for (const name of deeper.names) names.add(name);
            if (!deeper.fullyResolved) fullyResolved = false;
        }
    }
    return { names, fullyResolved };
};

/** The bare class name for a message (e.g. `...Weapons.TurretWeaponRules` -> `TurretWeaponRules`). */
const shortName = (cls: string): string => cls.slice(cls.lastIndexOf('.') + 1);
