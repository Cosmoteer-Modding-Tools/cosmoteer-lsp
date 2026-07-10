import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isValueNode } from '../core/ast/ast';
import { parseFilePath } from '../utils/ast.utils';
import { safeReaddir } from '../utils/fs.utils';
import { isManifestBasename } from '../document/document-kind';
import { uriToFsPath } from '../features/navigation/workspace-files';
import { FileWithPath, isFile } from '../workspace/cosmoteer-workspace.service';
import { ParserResultRegistrar } from '../registrar/parser-result-registrar';
import { findModRoot } from './mod-root';
import { parseModActions } from './action-parser';
import { resolveActionTarget } from './action-target-resolver';

/** Load a mod file, preferring the live in-editor (possibly unsaved) buffer over disk. */
const loadDocument = async (osPath: string): Promise<AbstractNodeDocument | null> =>
    ParserResultRegistrar.instance.getResultByPath(osPath) ?? (await parseFilePath(osPath).catch(() => null));

/** A path in canonical compare form: forward slashes, lowercased (Windows-style folding). */
const canonical = (path: string): string => path.replace(/\\/g, '/').toLowerCase();

/**
 * The game-tree nodes a document's content is merged into by its mod's `Overrides` actions.
 *
 * A mod patches a vanilla part by pairing a sparse local file with a manifest action
 * (`OverrideIn = "<./Data/ships/…/airlock.rules>"  Overrides = &<ships/…/airlock.rules>`). At
 * runtime the local file's members merge into the vanilla target, so references written in the
 * local file (component ids, most importantly) resolve against the merged result. This finds every
 * such target for a document, letting callers fold the target's contents into their resolution
 * scope.
 *
 * @param documentUri the document whose override targets are wanted (an override source file).
 * @param cancellationToken cancels the manifest reads and target navigation.
 * @returns the resolved target nodes, empty when the document is not an override source.
 */
export const overrideTargetsOf = async (
    documentUri: string,
    cancellationToken: CancellationToken
): Promise<AbstractNode[]> => {
    const modRoot = findModRoot(documentUri);
    if (!modRoot) return [];
    const documentPath = canonical(uriToFsPath(documentUri));
    const targets: AbstractNode[] = [];
    for (const name of safeReaddir(modRoot).filter(isManifestBasename).sort()) {
        if (cancellationToken.isCancellationRequested) break;
        const manifest = await loadDocument(join(modRoot, name));
        if (!manifest) continue;
        for (const action of parseModActions(manifest)) {
            if (action.type !== 'Overrides') continue;
            const source = action.sources[0];
            const target = action.targets[0];
            if (!target || !source || !isValueNode(source) || source.valueType.type !== 'Reference') continue;
            // The source `&<relpath>[/Members…]` names a file of the mod; match it to the document.
            const file = /<([^>]+)>/.exec(String(source.valueType.value))?.[1];
            if (!file) continue;
            const withExt = /\.[^/\\.]+$/.test(file) ? file : `${file}.rules`;
            if (canonical(join(modRoot, withExt)) !== documentPath) continue;
            const resolved = await resolveActionTarget(target, cancellationToken);
            if (!resolved) continue;
            if (isFile(resolved as FileWithPath)) {
                const parsed = await loadDocument((resolved as FileWithPath).path);
                if (parsed) targets.push(parsed);
            } else {
                targets.push(resolved as AbstractNode);
            }
        }
    }
    return targets;
};
