import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, isValueNode } from '../../core/ast/ast';
import { isLocalizationKeyType } from '../../document/schema/schema';
import { fieldOfValueNode } from '../completion/autocompletion.schema';
import { LocalizationKeyIndex } from '../completion/localization-key.index';
import * as l10n from '@vscode/l10n';

/**
 * Hover markdown for a localization-key value (a `KeyString` field such as `NameKey = "Parts/Foo"`):
 * the translated text in each language that declares the key. Lets you read what a key path *means*
 * without opening the strings file. Returns null when the node is not a literal localization key
 * (a reference-valued or empty `KeyString`, or any other field) so the generic hover handles it.
 *
 * @param node the hovered node.
 * @param folderPaths the project folders the strings index is built from.
 * @param cancellationToken cancellation for the index build.
 * @returns the hover markdown block, or null when this node is not a literal localization key.
 */
export const localizationKeyHover = async (
    node: AbstractNode,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<string | null> => {
    // Only a literal key path (`"Parts/Foo"`); a reference-valued `KeyString` (`&<…>/NameKey`) is
    // described by the reference hover instead.
    if (!isValueNode(node) || node.valueType.type !== 'String') return null;
    const key = String(node.valueType.value).trim();
    if (!key) return null;

    const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
    if (!isLocalizationKeyType(field?.valueType)) return null;

    const texts = await LocalizationKeyIndex.instance.textsForKey(key, folderPaths, cancellationToken).catch(() => []);
    if (texts.length === 0) {
        return `**${l10n.t('localization key')}** \`${key}\` — ${l10n.t('not found in any strings file')}`;
    }
    const lines = [`**${l10n.t('localization key')}** \`${key}\``];
    for (const { language, text } of texts) lines.push(`"${text}" — ${language}`);
    return lines.join('\n\n');
};
