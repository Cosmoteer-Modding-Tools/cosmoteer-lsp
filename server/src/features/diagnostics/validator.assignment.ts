import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AssignmentNode, isAssignmentNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { isModRules } from '../../document/document-kind';
import { isStringsFile } from '../../mod/strings-folder';
import { Validation, ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

export const ValidationForAssignment: Validation<AssignmentNode> = {
    type: 'Assignment',
    callback: async (node: AssignmentNode, cancellationToken: CancellationToken) => {
        const missingSeparator = await checkMissingFieldSeparator(node, cancellationToken);
        if (missingSeparator) return missingSeparator;
        if (isModRules(getStartOfAstNode(node).uri)) return; // We can't validate mod.rules at the moment
        if (node.right && node.right.type === 'Value' && node.right.valueType.type === 'Reference') {
            if (node.right.quoted && node.right.valueType.value.startsWith('&')) {
                return {
                    message: l10n.t('Reference should not be quoted'),
                    node: node.right,
                    additionalInfo: l10n.t('Remove the quotes — a "&" reference is written without quotation marks'),
                };
            } else if (
                node.right.valueType.value.startsWith('<') ||
                node.right.valueType.value.startsWith('..') ||
                node.right.valueType.value.startsWith('~') ||
                node.right.valueType.value.startsWith('^')
            ) {
                return {
                    message: l10n.t('Reference should start with an ampersand'),
                    node: node.right,
                    additionalInfo: l10n.t('Prefix the reference with "&", e.g. "&{0}"', String(node.right.valueType.value)),
                };
            }
        }
    },
};

/**
 * Flags a field whose value swallowed the NEXT field because the separator between them is missing
 * (`A = 1 B = 2` on one line). ObjectText only ends a value at `;`, `,`, a line break or the parent
 * brace, so the game silently reads `1 B = 2` as A's whole value. The parser mirrors that by
 * producing a nested assignment whose left identifier contains the merged `value identifier` text.
 * Whitespace in that identifier is the detection signal (a genuine identifier can never contain
 * whitespace). Strings files are exempt: their values are localization text where `=` is literal.
 *
 * @param node the assignment to inspect.
 * @param cancellationToken cancels the strings-folder lookup.
 * @returns a warning with an insert-separator quick-fix, or undefined when the shape is fine.
 */
export const checkMissingFieldSeparator = async (
    node: AssignmentNode,
    cancellationToken: CancellationToken
): Promise<ValidationError | undefined> => {
    // `right` is typed without Assignment because the parser only produces the nested shape for
    // exactly this malformed input, so the guard narrows through unknown.
    const inner = node.right as unknown as AbstractNode;
    if (!isAssignmentNode(inner)) return undefined;
    const mergedName = inner.left.name;
    const lastWhitespace = /\s+(?=\S+$)/.exec(mergedName);
    if (!lastWhitespace) return undefined;
    if (await isStringsFile(getStartOfAstNode(node).uri, cancellationToken)) return undefined;
    const separated =
        mergedName.slice(0, lastWhitespace.index) +
        ', ' +
        mergedName.slice(lastWhitespace.index + lastWhitespace[0].length);
    return {
        message: l10n.t('Missing separator between fields'),
        node: inner.left,
        severity: 'warning',
        additionalInfo: l10n.t(
            'The game reads everything up to the line end as a single value. Separate the fields with "," or ";", or move the second field to its own line'
        ),
        data: { quickFix: { title: l10n.t('Insert ","'), newText: separated } },
    };
};
