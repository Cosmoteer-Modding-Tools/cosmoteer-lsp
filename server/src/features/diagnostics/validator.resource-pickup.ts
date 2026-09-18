import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ValueNode,
    descendants,
    isAssignmentNode,
    isGroupNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { documentRootClass } from '../../document/schema/document-root';
import { classAncestry } from '../../document/schema/schema';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { MemberInjectionIndex } from '../../mod/member-injection.index';
import { flattenGroup } from '../../semantics/effective-group';
import { evaluateNumericValue } from '../../semantics/value-evaluator';
import { documentsMentioning } from '../../workspace/workspace-files';
import { numberOf } from '../../semantics/vector-forms';
import { ValidationError } from './validator';

/**
 * Whole-document pass (default on, settable off, needs the game index): a resource storage that
 * hands a crew more of a resource than a crew member can carry, which destroys the difference.
 *
 * The storage works out how much to give from its own `MaxResourcesPickUp` or `InitPickUp` and then
 * subtracts exactly that number from itself, while the crew's carried-resource setter clamps what
 * arrives to the resource type's `MaxPerNugget`. Nothing reconciles the two, so the overshoot is
 * annihilated. `InitPickUp` is the sharp half: the game forces an exact one-shot transfer of it and
 * skips the rate throttle, so every first pickup loses the difference. `MaxResourcesPickUp` leaks
 * once the crew is already full, and on a generating source the crew never departs either, because
 * the job waits for a count the clamp keeps it from reaching.
 *
 * The invariant is visibly designed into the game's own data: its largest pickup is exactly the
 * battery's stack size, and the mods that wanted a bigger one raised the stack to match rather than
 * overshooting.
 *
 * This is the one check here that reads a number out of another file, because the two halves are
 * declared apart: the pickup on the part, the stack on the resource. That also makes it the one
 * that has to see what a manifest does, since raising the stack through a mod action is exactly how
 * the mods that need a bigger pickup make it legal. A replacement of the member is read. A
 * replacement of the registry entry the id resolves through is not modelled anywhere, so a project
 * whose manifest rewrites the resource registry is left unjudged rather than judged on the game's
 * own numbers.
 */

/** The base class of every component that hands resources to a crew. */
const STORAGE_CLASS = 'Cosmoteer.Ships.Parts.Resources.BaseResourceStorageRules';

/** The class a resource file's whole-file root resolves to. */
const RESOURCE_CLASS = 'Cosmoteer.Resources.ResourceRules';

/** The two pickup sizes the storage subtracts unclamped, and the stack they are bounded by. */
const PICKUP_FIELDS: readonly string[] = ['MaxResourcesPickUp', 'InitPickUp'];
const MAX_PER_NUGGET = 'MaxPerNugget';

/** What a resource id resolved to, or why it was not judged. */
interface ResourceStack {
    /** The stack size the game reads, with any manifest replacement of the member applied. */
    readonly maxPerNugget: number;
    /** The id as the declaring file spells it, for the message. */
    readonly id: string;
}

/** Resolved stacks by folded id, so a part naming one resource many times resolves it once. */
const stackCache = new Map<string, ResourceStack | null>();

/**
 * The number a node holds, read through any arithmetic written on it.
 *
 * @param node the value node.
 * @param cancellationToken cancels the evaluation.
 * @returns the number, or null when it does not resolve to one.
 */
const numberFrom = async (
    node: AbstractNode | undefined,
    cancellationToken: CancellationToken
): Promise<number | null> => {
    if (!node) return null;
    const plain = numberOf(node);
    if (plain !== null) return plain;
    const evaluated = await evaluateNumericValue(node, cancellationToken).catch(() => null);
    return evaluated === null || !Number.isFinite(evaluated) ? null : evaluated;
};

/**
 * A document's top-level member, as the game reads it once a manifest has had its say.
 *
 * @param document the resource file.
 * @param name the member name.
 * @returns the member's value, or undefined when nothing writes it.
 */
const topLevelMember = (document: AbstractNodeDocument, name: string): AbstractNode | undefined => {
    const replaced = MemberInjectionIndex.instance.injectedReplacement(document, name);
    if (replaced) return replaced;
    const folded = name.toLowerCase();
    for (const element of document.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === folded) return element.right ?? undefined;
    }
    return undefined;
};

/**
 * The stack size of the resource an id names.
 *
 * @param id the written resource id.
 * @param folderPaths the project folders the candidate walk reads through.
 * @param cancellationToken cancels the walk.
 * @returns the resolved stack, or null when the id names no resource this server can read.
 */
const stackOf = async (
    id: string,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ResourceStack | null> => {
    const key = id.toLowerCase();
    const cached = stackCache.get(key);
    if (cached !== undefined) return cached;
    let found: ResourceStack | null = null;
    let declarations = 0;
    for await (const document of documentsMentioning(folderPaths, id, cancellationToken)) {
        if (documentRootClass(document) !== RESOURCE_CLASS) continue;
        const declared = topLevelMember(document, 'ID');
        if (!declared || !isValueNode(declared)) continue;
        if (String(declared.valueType.value).trim().toLowerCase() !== key) continue;
        declarations += 1;
        // Two files declaring one id means the project swaps the resource out, and which of them
        // the game reads is decided by an action on the registry list. A target whose last segment
        // is a list index is deliberately unmodelled, since the game renumbers the list, so the
        // winner is not knowable here and neither file may be held against the pickup.
        if (declarations > 1) {
            found = null;
            break;
        }
        const written = await numberFrom(topLevelMember(document, MAX_PER_NUGGET), cancellationToken);
        // A resource that writes no stack at all is left unjudged. Its initialiser is 1, so every
        // pickup above one would be a finding, and the resources written that way are the internal
        // ones no crew ever carries, where the loss the check describes cannot happen.
        if (written === null) continue;
        found = { maxPerNugget: written, id: String(declared.valueType.value).trim() };
    }
    stackCache.set(key, found);
    return found;
};

/**
 * Drops the resolved stacks, so a later scan reads the resource files again.
 *
 * The values come from other files, and nothing here watches them. The pass clears the cache once
 * per document, which keeps a part naming one resource many times to a single walk without ever
 * serving a number from a file that has since changed.
 */
export const clearResourceStackCache = (): void => stackCache.clear();

/**
 * Flags a storage whose pickup size is bigger than the resource's stack.
 *
 * @param group the storage component group.
 * @param folderPaths the project folders the resource lookup reads through.
 * @param cancellationToken cancels the folds and the lookup.
 * @param errors collects the findings.
 */
const judgeStorage = async (
    group: GroupNode,
    folderPaths: string[],
    cancellationToken: CancellationToken,
    errors: ValidationError[]
): Promise<void> => {
    const folded = await flattenGroup(group, cancellationToken).catch(() => null);
    // A pickup the chain supplies elsewhere, or a resource type it names elsewhere, is as much a
    // part of what the game reads as a local one, and half a chain cannot answer either.
    if (!folded || !folded.complete) return;
    const members = new Map<string, AbstractNode>();
    for (const member of folded.members) {
        if (member.value) members.set(member.name.toLowerCase(), member.value);
    }
    const resourceType = members.get('resourcetype');
    if (!resourceType || !isValueNode(resourceType)) return;
    const written = (resourceType as ValueNode).valueType;
    if (written.type === 'Reference') return;
    const id = String(written.value).trim();
    if (!id) return;
    const stack = await stackOf(id, folderPaths, cancellationToken);
    if (!stack) return;
    for (const field of PICKUP_FIELDS) {
        const node = members.get(field.toLowerCase());
        const value = await numberFrom(node, cancellationToken);
        if (node === undefined || value === null || value <= stack.maxPerNugget) continue;
        errors.push({
            message: l10n.t(
                "A crew member carries at most {0} {1}, and the storage hands out {2} and then takes all {2} out of itself, so the difference is destroyed. Either bring '{3}' down to {0} or raise the resource's MaxPerNugget.",
                stack.maxPerNugget,
                stack.id,
                value,
                field
            ),
            node,
            severity: 'warning',
        });
    }
};

/**
 * Runs the pickup-size check over a document.
 *
 * @param document the parsed document to validate.
 * @param folderPaths the project folders the resource lookup reads through.
 * @param cancellationToken cancels the walk and the cross-file reads.
 * @returns the findings, in source order.
 */
export const validateResourcePickups = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    clearResourceStackCache();
    const errors: ValidationError[] = [];
    for (const node of descendants(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        if (!isGroupNode(node)) continue;
        const cls = resolveGroupClass(node);
        if (!cls || !classAncestry(cls).includes(STORAGE_CLASS)) continue;
        await judgeStorage(node, folderPaths, cancellationToken, errors);
    }
    return errors;
};
