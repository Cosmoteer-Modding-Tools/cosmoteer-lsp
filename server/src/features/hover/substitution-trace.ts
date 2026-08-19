import * as l10n from '@vscode/l10n';
import { basenameOf } from '../../document/document-kind';
import { formatNumber, Substitution, TracedValue } from '../../semantics/value-evaluator';
import { globalSettings } from '../../settings';

/**
 * One trace line: the reference as written, the number it stood for, and where that number lives.
 * A target in the hovered file is placed by line alone, anything else names its file too.
 *
 * @param entry the recorded substitution.
 * @param documentUri the uri of the document the hover was requested on.
 * @returns the markdown text of the line, without its bullet or indent.
 */
const describe = (entry: Substitution, documentUri: string): string => {
    const path = '`' + entry.path.replace(/`/g, "'") + '`';
    // The number the game substitutes into the expression, so a `300%` source reads as 3. Units
    // belong to the final slot and are already on the computed-value line above this block.
    const value = formatNumber(entry.value);
    // AST lines are zero-based, the editor's gutter is not.
    const line = String(entry.line + 1);
    return entry.uri === documentUri
        ? l10n.t('{0} = {1} on line {2}', path, value, line)
        : l10n.t('{0} = {1} in {2}:{3}', path, value, basenameOf(entry.uri), line);
};

/**
 * The markdown block listing what a computed value's references stood for, rendered under the
 * computed number itself. This is the step the game's own evaluator performs before it does any
 * arithmetic, and the only part of the computation the source text does not already show. A
 * reference whose target is itself computed nests one level under it.
 *
 * The whole block is a single string, since the hover joins its sections with a blank line and a
 * blank line between list items would break the nesting.
 *
 * @param documentUri the uri of the document the hover was requested on.
 * @param traced the evaluated value together with the substitutions it took.
 * @returns the markdown block, or null when the setting is off or nothing was recorded.
 */
export const substitutionTraceMarkdown = (documentUri: string, traced: TracedValue): string | null => {
    if (globalSettings.hover?.showSubstitutions === false) return null;
    if (traced.substitutions.length === 0) return null;
    const lines = traced.substitutions.map((entry) => `${'  '.repeat(entry.depth)}- ${describe(entry, documentUri)}`);
    if (traced.omitted > 0) lines.push(`- ${l10n.t('… and {0} more', String(traced.omitted))}`);
    return lines.join('\n');
};
