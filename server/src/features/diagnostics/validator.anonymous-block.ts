import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isDocumentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * Flags every `{`/`[` block that opens without a name in front of it in group or document scope. A
 * block is unnamed only where its position carries no meaning, which the game answers by throwing so
 * that the whole file fails to load. Inside a `[` list the position is the name, so list elements
 * are exempt. Only the direct elements of a
 * scope are judged, which leaves the legal identifier-less blocks alone: the body of `X = { … }` hangs
 * off its assignment and the body of `X : Base { … }` off its inheritance, and neither is an element
 * of the enclosing scope.
 *
 * @param document the parsed document.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per unnamed block in a group or document scope.
 */
export const validateAnonymousBlocks = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const visit = (node: AbstractNode): void => {
        if (cancellationToken.isCancellationRequested) return;
        // The body of an assignment is reached through the assignment, so that its own children are
        // judged even though the body itself is exempt.
        if (isAssignmentNode(node)) {
            if (node.right) visit(node.right);
            return;
        }
        if (!isGroupNode(node) && !isListNode(node) && !isDocumentNode(node)) return;
        const namesElements = !isListNode(node);
        for (const element of node.elements) {
            if ((isGroupNode(element) || isListNode(element)) && !element.identifier && namesElements) {
                errors.push({
                    message: l10n.t('This block needs a name'),
                    node: element,
                    additionalInfo: l10n.t(
                        'An unnamed block is only allowed inside a "[" list, where its position is its name. Everywhere else the game expects a name in front of the block and fails to load the whole file without one.'
                    ),
                });
            }
            visit(element);
        }
    };
    visit(document);
    return errors;
};
