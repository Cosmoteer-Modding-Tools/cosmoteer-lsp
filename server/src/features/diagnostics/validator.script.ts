import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, descendants, isValueNode } from '../../core/ast/ast';
import { compileScriptAt } from '../scripting/script-field';
import { ValidationError } from './validator';

/**
 * Whole-document pass (default on): a rules script the game's compiler refuses. Since 0.30.5 the
 * music and codex script fields are no longer Python but a small expression language the game
 * compiles when it loads the rules, so a script that does not compile stops the load. The message is
 * the game's own, placed on the token it names.
 *
 * @param document the parsed document.
 * @param text the document text, which the script offsets are read against.
 * @param cancellationToken cancels the walk.
 * @returns the findings, in source order.
 */
export const validateScripts = async (
    document: AbstractNodeDocument,
    text: string,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    for (const node of descendants(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        if (!isValueNode(node)) continue;
        const script = await compileScriptAt(node, text, cancellationToken);
        const error = script?.result.error;
        if (!script || !error) continue;
        errors.push({
            message: l10n.t('The game refuses to load this script: {0}', error.message),
            node,
            range: script.toDocument(error.start, error.end),
            severity: 'error',
        });
    }
    return errors;
};
