import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode } from '../../core/ast/ast';
import { BUCKET_REGISTRY_CLASS, bucketListsIn } from '../diagnostics/validator.effect-bucket';
import { parseFilePath } from '../../utils/ast.utils';
import { ParserResultRegistrar } from '../../registrar/parser-result-registrar';
import { uriToFsPath } from '../navigation/workspace-files';
import { resolveSchemaIdReference, schemaReferenceFieldOf } from '../navigation/schema-id-reference.navigation';

/**
 * Hover markdown for a media-effect bucket name (`Bucket = CannonShoot`): which of the registry's
 * five lists holds it, where in that list it sits, and what it therefore draws between.
 *
 * The bucket registry is one long file of bare names, and a name says nothing on its own: what it
 * decides is draw order, and draw order is the position of the name in its list. Answering "does
 * this draw over the hull or under it" meant opening the registry and counting. The number and the
 * two neighbours are the whole answer.
 *
 * Only the bucket's own declaration is read. Whether the name resolves at all is the reference
 * validator's question, and it already answers it, so a name that resolves to nothing gets no hover
 * rather than a second opinion.
 */

/**
 * The parsed document for a uri, preferring the live editor buffer over the file on disk.
 *
 * @param uri the document's uri.
 * @returns the parsed document, or null when it cannot be read.
 */
const documentFor = async (uri: string) => {
    const path = uriToFsPath(uri);
    return ParserResultRegistrar.instance.getResultByPath(path) ?? (await parseFilePath(path).catch(() => null));
};

/**
 * Hover markdown naming where a bucket sits in its draw order.
 *
 * @param node the hovered node.
 * @param folderPaths the project folders the id index is built from.
 * @param cancellationToken cancels the id resolution and the parse.
 * @returns the hover block, or null when the node is not a bucket name that resolves.
 */
export const bucketOrderHover = async (
    node: AbstractNode,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<string | null> => {
    const reference = schemaReferenceFieldOf(node);
    if (!reference || reference.targetClass !== BUCKET_REGISTRY_CLASS) return null;
    const name = reference.value.trim();
    if (!name) return null;

    const location = await resolveSchemaIdReference(node, folderPaths, cancellationToken).catch(() => null);
    if (!location) return null;
    const document = await documentFor(location.uri);
    if (!document) return null;

    for (const list of bucketListsIn(document)) {
        const index = list.entries.findIndex(
            (entry) => String(entry.valueType.value).trim().toLowerCase() === name.toLowerCase()
        );
        if (index < 0) continue;
        const below = index > 0 ? String(list.entries[index - 1].valueType.value).trim() : undefined;
        const above =
            index + 1 < list.entries.length ? String(list.entries[index + 1].valueType.value).trim() : undefined;
        const place = l10n.t(
            '**{0}** in `{1}`, #{2} of {3}',
            name,
            list.field,
            String(index + 1),
            String(list.entries.length)
        );
        // The list is read in order, so a later entry draws over an earlier one.
        const between = below
            ? above
                ? l10n.t('draws over `{0}`, under `{1}`', below, above)
                : l10n.t('draws over `{0}`, and over everything else in this list', below)
            : above
              ? l10n.t('draws under `{0}`, and under everything else in this list', above)
              : l10n.t('the only bucket in this list');
        return `${place}. ${between}.`;
    }
    return null;
};
