import { CancellationToken, Location, Range } from 'vscode-languageserver';
import { AbstractNode, isValueNode } from '../../core/ast/ast';
import { isLocalizationKeyType } from '../../document/schema/schema';
import { parseFilePath } from '../../utils/ast.utils';
import { fieldOfValueNode } from '../completion/autocompletion.schema';
import { isEnglish, keyDeclarationsOf, LocalizationKeyIndex } from '../completion/localization-key.index';
import { languageOf } from '../completion/localization-key.index';
import { filePathToUri } from './navigation-strategy';
import { uriToFsPath } from './workspace-files';

/**
 * Go-to-definition for a localization key (`NameKey = "Parts/Foo"`).
 *
 * A `KeyString` value is a path into the strings files rather than a reference, so the `&` machinery
 * never sees it, and the reader who wants to read or fix the text has no way to reach it. Every
 * language that declares the key is an answer, English first, since that is the one a modder edits.
 *
 * @param node the value node under the cursor.
 * @param folderPaths the project folders the strings index is built from.
 * @param cancellationToken cancels the index build and the parses.
 * @returns the declaration locations, or null when the node is not a declared localization key.
 */
export const resolveLocalizationKeyDefinition = async (
    node: AbstractNode | null | undefined,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<Location[] | null> => {
    if (!node || !isValueNode(node) || node.valueType.type !== 'String') return null;
    const key = String(node.valueType.value).trim();
    if (!key) return null;

    const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
    if (!isLocalizationKeyType(field?.valueType)) return null;

    const sources = await LocalizationKeyIndex.instance
        .sourcesDeclaring(key, false, folderPaths, cancellationToken)
        .catch(() => [] as string[]);
    const wanted = key.toLowerCase();
    const found: Array<{ english: boolean; location: Location }> = [];
    for (const source of sources) {
        if (cancellationToken.isCancellationRequested) break;
        const path = uriToFsPath(source);
        const document = await parseFilePath(path).catch(() => null);
        if (!document) continue;
        for (const declaration of keyDeclarationsOf(document)) {
            if (!declaration.nameNode || declaration.path.toLowerCase() !== wanted) continue;
            const { line, characterStart, characterEnd } = declaration.nameNode.position;
            found.push({
                english: isEnglish(languageOf(document)),
                location: { uri: filePathToUri(path), range: Range.create(line, characterStart, line, characterEnd) },
            });
        }
    }
    if (!found.length) return null;
    found.sort((a, b) => Number(b.english) - Number(a.english));
    return found.map((entry) => entry.location);
};
