import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { flattenGroup } from '../../semantics/effective-group';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { memberOf, partComponentGroupsIn } from './part-component-graph';
import { PLAIN_ID } from './validator.schema-sibling';
import { ValidationError } from './validator';

/**
 * Whole-document pass (default on, settable off): a resource storage composed, directly or round a
 * ring, out of itself.
 *
 * A `MultiResourceStorage` answers how much it holds by asking each storage it names, and an
 * `InlineResourceConverter` by asking the one storage it converts from. Neither resolution carries
 * a visited set, and the multi storage caches its answer only after the summing loop has run, so
 * the cache cannot break the recursion either. Both components reach their own getter while they
 * are being added to the part, so a ring is unbounded recursion the first time the part is built:
 * placing it in the editor, or loading any ship that already carries one. A stack overflow cannot
 * be caught in the runtime the game is built on, so the process disappears with no dialog and
 * nothing in the log.
 *
 * The self-naming case resolves rather than failing because the part registers every component id
 * before calling any of their added-to-part handlers, so a component can find itself by name.
 *
 * The graph is the part's own `Components` group folded through its bases and whatever a manifest
 * merges into it, which is the dictionary the engine resolves these names against. An edge to a
 * component of any other type is a sink: a plain storage or a resource grid answers from its own
 * state and asks nobody, so a chain cannot continue through one. An edge naming a component the
 * group does not hold is left alone, since a name resolving to nothing is a different mistake with
 * a check of its own.
 *
 * What this cannot see: a storage a buff adds at runtime through `ViaBuffs`, and a storage proxy,
 * whose target is named by a proxy rather than by a component id.
 */

/** The storage that sums the storages it names, and the member holding those names. */
const MULTI_STORAGE_CLASS = 'Cosmoteer.Ships.Parts.Resources.MultiResourceStorageRules';
const RESOURCE_STORAGES = 'resourcestorages';

/** The converter that reads through one other storage, and the member naming it. */
const INLINE_CONVERTER_CLASS = 'Cosmoteer.Ships.Parts.Resources.InlineResourceConverterRules';
const FROM_STORAGE = 'fromstorage';

/** One component of the part's dictionary, with the storages it composes itself out of. */
interface StorageNode {
    /** The id as written, for the message. */
    readonly name: string;
    /** The values naming the storages this one reads through, in source order. */
    readonly reads: readonly ValueNode[];
}

/**
 * The ids a value names plainly, whether it is one name or a list of them.
 *
 * A reference is left out: it names its target through a path rather than through the part's
 * dictionary, so the engine's own lookup is not what resolves it and this graph does not model it.
 *
 * @param written the member's value, or undefined when the component does not write it.
 * @returns the value nodes naming a component, in source order.
 */
const plainIdsOf = (written: AbstractNode | undefined): ValueNode[] => {
    if (!written) return [];
    const candidates = isListNode(written) ? written.elements : [written];
    return candidates.filter(
        (node): node is ValueNode =>
            isValueNode(node) &&
            node.valueType.type !== 'Reference' &&
            PLAIN_ID.test(String(node.valueType.value).trim())
    );
};

/**
 * The storages one component reads through, when its class is one of the two that read through any.
 *
 * @param group the component's own group.
 * @returns the value nodes naming the storages it composes itself out of.
 */
const readsOf = (group: GroupNode): ValueNode[] => {
    const cls = resolveGroupClass(group);
    if (cls === MULTI_STORAGE_CLASS) return plainIdsOf(memberOf(group, RESOURCE_STORAGES));
    if (cls === INLINE_CONVERTER_CLASS) return plainIdsOf(memberOf(group, FROM_STORAGE));
    return [];
};

/**
 * The id a value node spells, folded for lookup in the dictionary.
 *
 * @param node the value node.
 * @returns the id in lower case.
 */
const idOf = (node: ValueNode): string => String(node.valueType.value).trim().toLowerCase();

/**
 * Flags a storage that composes itself, directly or round a ring of other storages.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per ring, anchored on a name this document writes.
 */
export const validateStorageCycles = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    const componentGroups: GroupNode[] = [];
    for (const element of document.elements) componentGroups.push(...partComponentGroupsIn(element));

    for (const components of componentGroups) {
        if (cancellationToken.isCancellationRequested) return errors;
        const flattened = await flattenGroup(components, cancellationToken).catch(() => null);
        // A ring leaving the part through a base this server cannot read may or may not close, and
        // the half of the dictionary that was read cannot tell which.
        if (!flattened || !flattened.complete) continue;

        const nodes = new Map<string, StorageNode>();
        for (const member of flattened.members) {
            const value = member.value;
            if (!value || !isGroupNode(value)) continue;
            nodes.set(member.name.toLowerCase(), { name: member.name, reads: readsOf(value) });
        }

        const reported = new Set<string>();
        const settled = new Set<string>();
        const onPath = new Set<string>();

        /**
         * Walks one storage and reports the first ring it closes.
         *
         * @param key the storage's folded id.
         * @returns nothing. Findings are collected in the enclosing scope.
         */
        const walk = (key: string): void => {
            if (settled.has(key)) return;
            onPath.add(key);
            for (const read of nodes.get(key)?.reads ?? []) {
                const next = idOf(read);
                if (!nodes.has(next)) continue;
                if (onPath.has(next)) {
                    // Report on the edge that closes the ring, and only where this document writes
                    // it, so a part inheriting a closed ring is reported in the file it lives in.
                    if (!reported.has(key) && getStartOfAstNode(read).uri === document.uri) {
                        reported.add(key);
                        errors.push({
                            message:
                                next === key
                                    ? l10n.t(
                                          'This storage reads its own contents to answer what it holds, so the question never ends and the game stops the moment a part with these components is built.'
                                      )
                                    : l10n.t(
                                          'This storage reads through a storage that reads back through it, so the question never ends and the game stops the moment a part with these components is built.'
                                      ),
                            node: read,
                            severity: 'error',
                        });
                    }
                    continue;
                }
                walk(next);
            }
            onPath.delete(key);
            settled.add(key);
        };

        for (const key of nodes.keys()) walk(key);
    }
    return errors;
};
