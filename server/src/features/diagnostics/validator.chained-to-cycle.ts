import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { childNodesOf, getStartOfAstNode } from '../../utils/ast.utils';
import { resolveGroupClass } from '../../document/schema/schema-context';
import { flattenGroup } from '../../semantics/effective-group';
import { PLAIN_ID } from './validator.schema-sibling';
import { ValidationError } from './validator';

/** The class whose `Components` group is the dictionary every chain is resolved against. */
const PART_RULES = 'Cosmoteer.Ships.Parts.PartRules';

/** The member holding the component a chainable component hangs its position and rotation off. */
const CHAINED_TO = 'chainedto';

/** The member of a part holding the components the game registers by id. */
const COMPONENTS = 'components';

/** One component of the part's dictionary, with the chain it declares. */
interface ChainNode {
    /** The id as written, for the message. */
    readonly name: string;
    /** The value naming the next component, or undefined when it chains to nothing. */
    readonly chainedTo?: ValueNode;
}

/**
 * The member written under `name` in a group, in both spellings the format allows.
 *
 * @param group the group to read.
 * @param name the folded member name.
 * @returns the member's value, or undefined when the group does not write it.
 */
const memberOf = (group: GroupNode, name: string): AbstractNode | undefined => {
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === name) return element.right ?? undefined;
        if (isGroupNode(element) && element.identifier?.name.toLowerCase() === name) return element;
    }
    return undefined;
};

/**
 * Every group a part writes its registered components into, which is the `Components` member of a
 * group the schema types as a part. A `Components` nested inside a toggled set is not one of them,
 * since the game reads those into a list of their own rather than into the part's dictionary.
 *
 * @param node the node to walk.
 * @returns a generator of the part-level component groups found under it.
 */
function* partComponentGroupsIn(node: AbstractNode): Generator<GroupNode> {
    if (isGroupNode(node) && resolveGroupClass(node) === PART_RULES) {
        const components = memberOf(node, COMPONENTS);
        if (components && isGroupNode(components)) yield components;
    }
    for (const child of childNodesOf(node)) yield* partComponentGroupsIn(child);
}

/**
 * The component a chain names, when it names one plainly.
 *
 * @param group the component's own group.
 * @returns the value node naming the next component, or undefined.
 */
const chainedToOf = (group: GroupNode): ValueNode | undefined => {
    const written = memberOf(group, CHAINED_TO);
    if (!written || !isValueNode(written)) return undefined;
    if (written.valueType.type === 'Reference') return undefined;
    return PLAIN_ID.test(String(written.valueType.value).trim()) ? written : undefined;
};

/**
 * Flags a component chain that comes back to a component it has already been through.
 *
 * A chainable component takes its position and its rotation from the component it is chained to by
 * asking that component for its own, and neither the reading side nor the running side carries a
 * visited set. A chain that closes is unbounded mutual recursion the moment the part is created,
 * and a stack overflow cannot be caught in the runtime the game is built on, so the process
 * disappears with no dialog and nothing in the log.
 *
 * The graph is the part's own `Components` group folded through its bases and whatever a manifest
 * merges into it, which is the dictionary the engine resolves a chain against. A component declared
 * inside a toggled set is left out for the same reason the game leaves it out. An edge naming a
 * component the group does not hold is left alone as well, since a name resolving to nothing is a
 * different mistake with a check of its own.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per chain that closes, anchored on a reference this document writes.
 */
export const validateChainedToCycles = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const componentGroups: GroupNode[] = [];
    for (const element of document.elements) componentGroups.push(...partComponentGroupsIn(element));

    for (const components of componentGroups) {
        if (cancellationToken.isCancellationRequested) return errors;
        const flattened = await flattenGroup(components, cancellationToken).catch(() => null);
        // A chain leaving the part through a base this server cannot read may or may not close, and
        // the half of the dictionary that was read cannot tell which.
        if (!flattened || !flattened.complete) continue;

        const nodes = new Map<string, ChainNode>();
        for (const member of flattened.members) {
            const value = member.value;
            if (!value || !isGroupNode(value)) continue;
            nodes.set(member.name.toLowerCase(), { name: member.name, chainedTo: chainedToOf(value) });
        }

        const nextOf = (key: string): string | undefined => {
            const chainedTo = nodes.get(key)?.chainedTo;
            if (!chainedTo) return undefined;
            const next = String(chainedTo.valueType.value).trim().toLowerCase();
            return nodes.has(next) ? next : undefined;
        };

        const finished = new Set<string>();
        const reported = new Set<string>();
        for (const start of nodes.keys()) {
            if (finished.has(start)) continue;
            const path: string[] = [];
            const onPath = new Set<string>();
            let current: string | undefined = start;
            while (current !== undefined && !finished.has(current)) {
                if (onPath.has(current)) {
                    // Report on one edge of the loop, and only where this document writes it, so a
                    // part inheriting a closed chain is reported in the file the chain lives in.
                    for (const key of path.slice(path.indexOf(current))) {
                        const chain = nodes.get(key)?.chainedTo;
                        if (!chain || reported.has(key)) continue;
                        if (getStartOfAstNode(chain).uri !== document.uri) continue;
                        reported.add(key);
                        errors.push({
                            message: l10n.t(
                                'This chain leads back to itself, so the game stops the moment a part with these components is created.'
                            ),
                            node: chain,
                            severity: 'error',
                        });
                        break;
                    }
                    break;
                }
                onPath.add(current);
                path.push(current);
                current = nextOf(current);
            }
            for (const key of path) finished.add(key);
        }
    }
    return errors;
};
