import * as l10n from '@vscode/l10n';
import { AbstractNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { basenameOf } from '../../document/document-kind';
import { code, linkDestination, plainPathOf } from './markdown-link';

/**
 * The two renderings every report shares once it puts a written value in a table: the value itself
 * on one line, and a link to the line it is written on.
 *
 * The reports are read side by side, so a value shown one way in one and another way in the next is
 * a difference the reader has to rule out before trusting either.
 */

/** How many characters of a written value a row shows before it is cut. */
export const VALUE_WIDTH = 60;

/** A place a report links to: the file, and the node whose line the link lands on. */
export interface ReportPlace {
    readonly uri: string;
    readonly node: AbstractNode;
}

/**
 * A markdown link to a node's position, labeled `file.rules:line`. Uses the `vscode://file/…` deep
 * link with a `:line` suffix, since markdown-it rejects the `file:` scheme outright.
 *
 * @param place the file and node to link to.
 * @returns the markdown link.
 */
export const placeLink = (place: ReportPlace): string => {
    const line = place.node.position.line + 1;
    const encoded = linkDestination(plainPathOf(place.uri));
    return `[${basenameOf(place.uri)}:${line}](vscode://file/${encoded}:${line})`;
};

/**
 * A written value rendered on one line. A container has no one-line spelling, so it is named by
 * kind and size rather than spelled out, which is what keeps a table row one row high.
 *
 * @param node the member's value node.
 * @returns the display text.
 */
export const valueText = (node: AbstractNode | null): string => {
    if (!node) return l10n.t('*(no value)*');
    if (isValueNode(node)) {
        const text = String(node.valueType.value);
        return code(text.length > VALUE_WIDTH ? `${text.slice(0, VALUE_WIDTH)}…` : text);
    }
    if (isListNode(node)) return l10n.t('*list of {0}*', String(node.elements.length));
    if (isGroupNode(node)) return l10n.t('*group of {0}*', String(node.elements.length));
    return l10n.t('*(unreadable)*');
};
