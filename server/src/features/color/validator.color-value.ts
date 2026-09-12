import * as l10n from '@vscode/l10n';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isValueNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { memberTypeIn } from '../../document/schema/schema-context';
import { childNodesOf } from '../../utils/ast.utils';
import { closestMatch } from '../../utils/did-you-mean';
import { didYouMeanFix, ValidationError } from '../diagnostics/validator';
import { NAMED_COLORS, namedColorOf } from '../text-markup/text-markup';

/**
 * Validates a colour written as a single value. `Color.ReadContentFrom` and
 * `IntColor.ReadContentFrom` read a lone value through `Color.NamedColors` and throw a
 * `DeserializeException` on anything the table does not hold, which takes the whole data tree down.
 * Hex is a text-markup form only, so `Color = ff0000` is one of the values that throws.
 *
 * The check is conservative so it stays false-positive-free: it fires only where the schema types
 * the slot as a colour and the written value is a plain word, never on a reference, a number, a
 * boolean, a math expression or a group and list form, all of which the engine reads some other way.
 */

/** The classes whose single-value form is a colour name. */
const COLOR_CLASSES: ReadonlySet<string> = new Set(['Halfling.Graphics.Color', 'Halfling.Graphics.IntColor']);

/**
 * Every colour name written as a single value that the engine's table does not hold.
 *
 * @param document the parsed document to validate.
 * @returns one finding per value the colour reader would throw on.
 */
export const validateColorValues = (document: AbstractNodeDocument): ValidationError[] => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    const visit = (node: AbstractNode): void => {
        if (isAssignmentNode(node) && isValueNode(node.right) && node.right.valueType.type === 'String') {
            const container = node.parent;
            const written = String(node.right.valueType.value).trim();
            if (written && (isGroupNode(container) || isDocumentNode(container))) {
                const slot = memberTypeIn(container, node.left.name);
                if (slot?.kind === 'group' && COLOR_CLASSES.has(slot.ref) && !namedColorOf(written)) {
                    errors.push({
                        message: l10n.t(
                            "'{0}' names no colour the game knows, so it refuses to load this file. Write one of its colour names, or the channels as a group or a list.",
                            written
                        ),
                        node: node.right,
                        severity: 'warning',
                        ...didYouMeanFix(closestMatch(written, [...NAMED_COLORS.keys()], true)),
                    });
                }
            }
        }
        for (const child of childNodesOf(node)) visit(child);
    };
    for (const element of document.elements) visit(element);
    return errors;
};
