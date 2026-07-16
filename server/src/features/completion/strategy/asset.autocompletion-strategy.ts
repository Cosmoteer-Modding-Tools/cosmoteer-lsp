import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { ValueNode } from '../../../core/ast/ast';
import { getStartOfAstNode } from '../../../utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../../workspace/cosmoteer-workspace.service';
import { assetBaseDirsFromInheritance, normalizeDir } from '../../diagnostics/asset-base-path';
import { FullNavigationStrategy } from '../../navigation/full.navigation-strategy';
import { AutoCompletionStrategy } from './autocompletion.strategy';
import { Completion } from '../autocompletion.service';
import {
    ALLOWED_AUDIO_EXTENSIONS,
    ALLOWED_IMAGE_EXTENSIONS,
    ALLOWED_SHADER_EXTENSIONS,
    assetExtensionsForType,
} from '../../../utils/constants';

const fullNav = new FullNavigationStrategy();
const ALL_ASSET_EXTENSIONS = [...ALLOWED_IMAGE_EXTENSIONS, ...ALLOWED_AUDIO_EXTENSIONS, ...ALLOWED_SHADER_EXTENSIONS];

/** The value-type name of an asset, selecting which file extensions are offered. */
export type AssetType = 'Sprite' | 'Sound' | 'Shader';

/**
 * Path-completion for asset values (sprites/sounds/shaders). Lists the directory the
 * partially-typed path points at: sub-directories (so you can drill down) and files of
 * the matching kind. Directories are resolved relative to the containing file, to any
 * inherited asset base, or (for `./Data/…`) to the game data root, mirroring how the
 * asset is actually resolved.
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

        for (const dir of await this.targetDirectories(dirPart, uri, node, cancellationToken)) {
            try {
                for (const entry of await readdir(dir, { withFileTypes: true })) {
                    if (cancellationToken.isCancellationRequested) return completions;
                    const name = entry.name;
                    if (partial && !name.toLowerCase().startsWith(partial.toLowerCase())) continue;
                    if (entry.isDirectory()) {
                        add({ label: name + '/', kind: CompletionItemKind.Folder, insertText: name + '/' });
                    } else if (entry.isFile() && extensions.some((extension) => name.toLowerCase().endsWith(extension))) {
                        add({ label: name, kind: CompletionItemKind.File, insertText: name });
                    }
                }
            } catch {
                // Directory does not exist (e.g. a partial/typo'd path). Nothing to list here.
            }
        }
        return completions;
    }

    /** The on-disk directories the committed path portion (`dirPart`) points at. */
    private async targetDirectories(
        dirPart: string,
        uri: string,
        node: ValueNode,
        cancellationToken: CancellationToken
    ): Promise<string[]> {
        if (/^\.\/data/i.test(dirPart)) {
            const rel = dirPart.replace(/^\.\/data\/?/i, '');
            return [join(CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath, rel)];
        }
        const dirs = [join(normalizeDir(uri), dirPart)];
        const baseDirs = await assetBaseDirsFromInheritance(
            node,
            uri,
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
            fullNav.navigate.bind(fullNav),
            cancellationToken
        ).catch(() => []);
        for (const base of baseDirs) dirs.push(join(base, dirPart));
        return dirs;
    }
}
