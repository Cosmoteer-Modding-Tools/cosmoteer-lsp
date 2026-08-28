import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ListNode,
    ValueNode,
} from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { listElementType } from '../../document/schema/schema-context';
import { ValidationError } from './validator';

/** The element class of the one list this check judges, an indicator sprite component's own. */
const INDICATOR_RULES = 'Cosmoteer.Ships.Parts.Graphics.PartIndicatorSpritesRules/IndicatorRules';

/** The member holding the indices an indicator hides while it is showing. */
const HIDES_INDICATORS = 'hidesindicators';

/**
 * The member written under `name` in a group, in the assignment and the named-block spellings.
 *
 * @param group the group to read.
 * @param name the member name, matched case-insensitively the way the game matches it.
 * @returns the member's value node, or undefined when the group does not write it.
 */
const memberOf = (group: GroupNode, name: string): AbstractNode | undefined => {
    for (const element of group.elements) {
        if (isAssignmentNode(element) && element.left.name.toLowerCase() === name) return element.right ?? undefined;
        if ((isGroupNode(element) || isListNode(element)) && element.identifier?.name.toLowerCase() === name) {
            return element;
        }
    }
    return undefined;
};

/**
 * The whole number a value node spells, or undefined for anything else. A reference or an
 * expression is left alone: it may work out to any index, and the check reports only what the
 * text decides on its own.
 *
 * @param node the value node to read.
 * @returns the integer it spells, or undefined.
 */
const integerOf = (node: AbstractNode): number | undefined => {
    if (!isValueNode(node)) return undefined;
    if (node.valueType.type === 'Reference') return undefined;
    const written = String(node.valueType.value).trim();
    if (!/^-?\d+$/.test(written)) return undefined;
    return Number(written);
};

/**
 * The indicator lists a node holds, walking into its children so a component nested anywhere under
 * the part is reached. Only a list the schema types as an indicator list is yielded, so a list of
 * the same name on another class is never judged.
 *
 * @param node the node to walk.
 * @returns a generator of the indicator lists found under it.
 */
function* indicatorListsIn(node: AbstractNode): Generator<ListNode> {
    if (isListNode(node)) {
        const element = listElementType(node);
        if (element?.kind === 'group' && element.ref === INDICATOR_RULES) yield node;
    }
    for (const child of childNodesOf(node)) yield* indicatorListsIn(child);
}

/**
 * Flags an indicator that hides an index its own list does not have, which is how a list edited at
 * the head goes wrong: an indicator is added or removed in front of the others and the numbers
 * underneath still name the old positions.
 *
 * The game answers both halves at load time and neither message reaches the author usefully. An
 * indicator naming its own index is a deserialization error saying an indicator cannot hide itself,
 * with nothing saying which one. An index past the end reaches the array unguarded, because the
 * engine bounds-checks its loop counter rather than the written value, so the file fails to load
 * with an index error carrying no message at all.
 *
 * Judged from the document alone, and only where the list's own text decides the answer. A list
 * declaring a base is skipped, since inherited entries come first and every written index means a
 * different position once they are folded in. A list holding anything other than groups is skipped
 * for the same reason.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per index that names its own indicator or no indicator at all.
 */
export const validateIndicatorIndexes = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    for (const element of document.elements) {
        if (cancellationToken.isCancellationRequested) return [];
        for (const list of indicatorListsIn(element)) {
            if (list.inheritance?.length) continue;
            if (!list.elements.every(isGroupNode)) continue;
            const indicators = list.elements as GroupNode[];
            const count = indicators.length;
            for (let index = 0; index < count; index++) {
                const hides = memberOf(indicators[index], HIDES_INDICATORS);
                const written: AbstractNode[] = hides
                    ? isListNode(hides)
                        ? hides.elements
                        : [hides]
                    : [];
                for (const value of written) {
                    const hidden = integerOf(value);
                    if (hidden === undefined) continue;
                    if (hidden === index) {
                        errors.push({
                            message: l10n.t(
                                'Indicator {0} cannot hide itself, so the game refuses to load this file.',
                                String(index)
                            ),
                            node: value as ValueNode,
                            severity: 'error',
                        });
                    } else if (hidden < 0 || hidden >= count) {
                        errors.push({
                            message: l10n.t(
                                'There is no indicator {0} in this list of {1}, so loading this file fails with an index error the game cannot name.',
                                String(hidden),
                                String(count)
                            ),
                            node: value as ValueNode,
                            severity: 'error',
                        });
                    }
                }
            }
        }
    }
    return errors;
};
