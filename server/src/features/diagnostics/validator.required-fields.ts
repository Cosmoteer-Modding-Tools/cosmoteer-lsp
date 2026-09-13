import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { childNodesOf, namedMembersOf, getStartOfAstNode } from '../../utils/ast.utils';
import {
    groupDiscriminator,
    registryForGroup,
    registryHintFromContainer,
    resolveGroupClass,
    slotDeclaredClass,
} from '../../document/schema/schema-context';
import { discriminatorIsAmbiguous, fieldsOf, requiredFieldsOf, typeDef } from '../../document/schema/schema';
import { SchemaField } from '../../document/schema/schema.types';
import { DefinitionService } from '../navigation/definition.service';
import { definitionLocationOf, locationKey } from '../navigation/reference-location';
import { findInheritorsOf } from '../../semantics/inheritor-resolver';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { ValidationError } from './validator';
import { requiredFieldInsert } from './required-field-insert';
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
 *   - Template skip: a group that some other group really inherits from is a template completed by its
 *     deriving groups, never instantiated on its own, so it is not checked. Unlike the allowlist this
 *     also covers a mod's own `BASE_*` templates. The test is positional: a base reference has to
 *     resolve to this very node. A bare name is not enough, since 15.7% of vanilla's typed named
 *     groups (`Sprite`, `BulletEmitter`, `Hit`, `Blueprints`) share a name with some base leaf
 *     somewhere else in the install, which would silence the whole class of them.
 *   - `~`-rooted bases and runtime/unresolvable inheritance skip the group (see the guard above).
 *   - mod.rules manifests are skipped (they are actions, not instances).
 *
 * The schema's `optional` flag is derived from real C# signals (explicit `Optional`, constructor
 * defaults, nullable annotation, inline empty alias, collection types, see `tools/schemagen`). The
 * workspace template index absorbs the cross-file `BASE_*` bases, and {@link RUNTIME_REQUIRED_ALLOWLIST}
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
    // Inheritance base references written in this document, keyed by the base's leaf name (`Floor :
    // BASE_SPRITES` → `base_sprites`). A candidate group named like one of them may be the template
    // those references point at, which the check confirms by resolving them (see
    // {@link isInheritanceBase}). The optional `workspaceBaseNames` opens the same question for the
    // cross-file bases a single file cannot see.
    const localBaseReferences = new Map<string, ValueNode[]>();
    const collect = (node: AbstractNode): void => {
        if (isGroupNode(node) || isListNode(node)) {
            for (const reference of node.inheritance ?? []) {
                if (!isValueNode(reference) || reference.valueType.type !== 'Reference') continue;
                const leaf = inheritanceBaseLeafName(reference.valueType.value);
                if (!leaf) continue;
                const key = leaf.toLowerCase();
                const bucket = localBaseReferences.get(key);
                if (bucket) bucket.push(reference);
                else localBaseReferences.set(key, [reference]);
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
            } else if (isSlotTypedInstance(node)) {
                groups.push(node);
            }
        }
        const children = childNodesOf(node);
        for (const child of children) collect(child);
    };
    for (const element of document.elements) collect(element);

    /**
     * Whether some group really inherits from this very node, which makes it a template rather than an
     * instance. Same-file base references are resolved first (they also see an unsaved edit), then the
     * cross-file ones the workspace index knows about. Only asked of a group that is already missing a
     * field, so the resolution cost lands on the few findings rather than on every typed group.
     *
     * @param group the candidate group.
     * @returns true when a base reference resolves to this group.
     */
    const isInheritanceBase = async (group: GroupNode): Promise<boolean> => {
        const name = group.identifier?.name;
        if (!name) return false;
        const key = locationKey(definitionLocationOf(group));
        for (const reference of localBaseReferences.get(name.toLowerCase()) ?? []) {
            const target = await DefinitionService.instance
                .resolveReferenceTarget(document, reference, cancellationToken)
                .catch(() => null);
            if (!target || isFile(target as FileWithPath)) continue;
            if (locationKey(definitionLocationOf(target as AbstractNode)) === key) return true;
        }
        if (!workspaceBaseNames?.has(name)) return false;
        return (await findInheritorsOf(group, cancellationToken).catch(() => [])).length > 0;
    };

    for (const group of groups) {
        if (cancellationToken.isCancellationRequested) break;
        const cls = resolveGroupClass(group);
        if (!cls) continue;
        const required = requiredFieldsOf(cls);
        if (required.length === 0) continue;

        // Lower-cased: a written `maxhealth` satisfies required `MaxHealth` (game lookup ignores case).
        const present = new Set(namedMembersOf(group).map(([name]) => name.toLowerCase()));
        const ancestry = await gatherInheritedNames(group, cancellationToken);
        // A base we cannot see might supply the field, so stay silent rather than guess.
        if (!ancestry.fullyResolved) continue;
        for (const name of ancestry.names) present.add(name.toLowerCase());

        const runtimeProvided = RUNTIME_REQUIRED_ALLOWLIST[cls];
        const missing = required.filter((field) => !isSatisfied(field, present) && !runtimeProvided?.has(field.name));
        if (missing.length === 0) continue;
        // A template completed by its deriving groups, not an instance, so not checked.
        if (await isInheritanceBase(group)) continue;
        // Where the quick fix writes the fields, computed here because the finding is anchored on the
        // group's name, which is not a place anything can be written. Undefined when the group cannot
        // be edited safely or when no missing field has a value the fix may invent, and then the
        // findings are reported without a fix.
        const insert = requiredFieldInsert(group, missing);
        for (const field of missing) {
            const error: ValidationError = {
                message: l10n.t("Missing required field '{0}' on {1}.", field.name, shortName(cls)),
                node: group.identifier ?? group,
                severity: 'warning',
            };
            const fieldIndex = insert ? insert.fields.findIndex((entry) => entry.name === field.name) : -1;
            if (insert && fieldIndex >= 0) error.data = { insertRequiredFields: { ...insert, fieldIndex } };
            errors.push(error);
        }
    }
    return errors;
};

/**
 * Whether a nested group is an instance the check may judge on its slot alone: its declaring field
 * names one concrete class, so no discriminator is involved, and nothing in its container chain
 * inherits. The chain matters because a deriving ancestor merges its base's tree in member by member,
 * so a nested group under one may be completed by a node this file never mentions.
 *
 * A file root is left out: an unrooted fragment's own root is typed by how something else pulls the
 * file in, and that is exactly the kind of guess this check must not build a warning on.
 *
 * @param group the candidate group.
 * @returns true when the group can be judged against its slot class.
 */
const isSlotTypedInstance = (group: GroupNode): boolean => {
    if (group.inheritance?.length) return false;
    let node: AbstractNode | undefined = group.parent ?? undefined;
    if (!node || isDocumentNode(node)) return false;
    while (node && !isDocumentNode(node)) {
        if ((isGroupNode(node) || isListNode(node)) && node.inheritance?.length) return false;
        node = node.parent ?? undefined;
    }
    const cls = slotDeclaredClass(group);
    return !!cls && !hasAlternativeWriteForms(cls);
};

/**
 * Whether a class is one the game reads through spellings other than its named members: a scalar form
 * (`Color = white`), or a positional one (`[0, 0, 0, 255]`, read through the class's digit fields).
 * Such a class has a deserializer of its own that accepts several shapes, so a named member being
 * absent says nothing about the write being incomplete: a `Color { Rf … }` and a `Color { R … }` are
 * the same value written two ways.
 *
 * @param cls the class FullName.
 * @returns true when the class carries more than one write form.
 */
const hasAlternativeWriteForms = (cls: string): boolean =>
    !!typeDef(cls)?.scalarForm || fieldsOf(cls).some((field) => /^\d+$/.test(field.name));

/** A required field is satisfied if it, or any of its aliases, is among the present member names (lower-cased on both sides). */
const isSatisfied = (field: SchemaField, present: Set<string>): boolean =>
    present.has(field.name.toLowerCase()) ||
    (field.aliases?.some((alias) => present.has(alias.toLowerCase())) ?? false);

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
        // The navigator answers a path whose last segment misses with the deepest container it did
        // reach, so a base naming a group that no longer exists lands on its parent. Taking that as
        // the base would judge the group against the wrong member set, so a resolved node whose name
        // is not the one the reference asked for counts as unresolved.
        const leaf = inheritanceBaseLeafName(refValue);
        const resolvedName = (isGroupNode(base) || isListNode(base)) && base.identifier?.name;
        if (leaf && resolvedName && /^[A-Za-z_]\w*$/.test(leaf) && resolvedName.toLowerCase() !== leaf.toLowerCase()) {
            fullyResolved = false;
            continue;
        }
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
