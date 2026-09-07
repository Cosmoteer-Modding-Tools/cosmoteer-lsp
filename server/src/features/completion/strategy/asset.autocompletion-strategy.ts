import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { join } from 'path';
import { ValueNode } from '../../../core/ast/ast';
import { getStartOfAstNode } from '../../../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../../workspace/cosmoteer-workspace.service';
import { cachedReaddir } from '../../../workspace/fs-cache';
import { normalizeDir } from '../../navigation/asset-resolver';
import { AutoCompletionStrategy } from './autocompletion.strategy';
import { Completion } from '../autocompletion.service';
import {
    ALLOWED_AUDIO_EXTENSIONS,
    ALLOWED_IMAGE_EXTENSIONS,
    ALLOWED_SHADER_EXTENSIONS,
    assetExtensionsForType,
} from '../../../utils/constants';

const ALL_ASSET_EXTENSIONS = [...ALLOWED_IMAGE_EXTENSIONS, ...ALLOWED_AUDIO_EXTENSIONS, ...ALLOWED_SHADER_EXTENSIONS];

/** The value-type name of an asset, selecting which file extensions are offered. */
export type AssetType = 'Sprite' | 'Sound' | 'Shader';

/**
 * Path-completion for asset values (sprites/sounds/shaders). Lists the directory the
 * partially-typed path points at: sub-directories (so you can drill down) and files of
 * the matching kind. Directories are resolved relative to the containing file, or (for
 * `./Data/…`) to the game data root, which is how the game resolves the asset.
 *
 * The asset kind is only known once an extension is present (`foo.png` → Sprite); while the
 * path is still extension-less it is a plain string, so we then offer files of any asset
 * kind and narrow once the extension is typed.
 */
export class AssetAutoCompletionStrategy extends AutoCompletionStrategy<
    Completion[],
    { node: ValueNode; cancellationToken: CancellationToken; assetType?: AssetType }
> {
    async complete(args: {
        node: ValueNode;
        cancellationToken: CancellationToken;
        assetType?: AssetType;
    }): Promise<Completion[]> {
        const { node, cancellationToken, assetType } = args;
        const value = String(node.valueType.value);
        const type = node.valueType.type;
        // Prefer the schema-declared asset kind (known before an extension is typed); otherwise fall
        // back to the kind the value text classifies into, and to every kind while still ambiguous.
        const resolvedType =
            assetType ?? (type === 'Sprite' || type === 'Sound' || type === 'Shader' ? type : undefined);
        const extensions = resolvedType ? assetExtensionsForType(resolvedType) : ALL_ASSET_EXTENSIONS;

        const lastSlash = value.lastIndexOf('/');
        const dirPart = lastSlash >= 0 ? value.slice(0, lastSlash) : '';
        const partial = lastSlash >= 0 ? value.slice(lastSlash + 1) : value;
        const uri = getStartOfAstNode(node).uri;

        const completions: Completion[] = [];
        const seen = new Set<string>();
        const add = (completion: { label: string; kind: CompletionItemKind; insertText: string }) => {
            if (seen.has(completion.label)) return;
            seen.add(completion.label);
            completions.push(completion);
        };

        // From an empty value, offer the game-data root as a starting point for absolute paths.
        if (value === '') add({ label: './Data/', kind: CompletionItemKind.Folder, insertText: './Data/' });

        const lowerPartial = partial.toLowerCase();
        const dir = this.targetDirectory(dirPart, uri);
        try {
            for (const entry of await cachedReaddir(dir)) {
                if (cancellationToken.isCancellationRequested) return completions;
                const name = entry.name;
                const lowerName = name.toLowerCase();
                if (partial && !lowerName.startsWith(lowerPartial)) continue;
                if (entry.isDirectory()) {
                    add({ label: name + '/', kind: CompletionItemKind.Folder, insertText: name + '/' });
                } else if (entry.isFile() && extensions.some((extension) => lowerName.endsWith(extension))) {
                    add({ label: name, kind: CompletionItemKind.File, insertText: name });
                }
            }
        } catch {
            // Directory does not exist (e.g. a partial/typo'd path). Nothing to list here.
        }
        return completions;
    }

    /**
     * The on-disk directory the committed path portion points at.
     *
     * @param dirPart the part of the value before its last slash.
     * @param uri the uri of the file the value is written in.
     * @returns the directory to list.
     */
    private targetDirectory(dirPart: string, uri: string): string {
        if (/^\.\/data/i.test(dirPart)) {
            const rel = dirPart.replace(/^\.\/data\/?/i, '');
            return join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, rel);
        }
        return join(normalizeDir(uri), dirPart);
    }
}
