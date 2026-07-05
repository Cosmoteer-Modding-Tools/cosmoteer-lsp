import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { AssetNavigationStrategy } from '../../../src/features/navigation/asset.navigation-strategy';
import { assetBaseDirsFromInheritance, overlayMergeDir } from '../../../src/features/diagnostics/asset-base-path';
import { AbstractNode, AbstractNodeDocument } from '../../../src/core/ast/ast';
import { findNodeByIdentifier, getStartOfAstNode, parseFilePath } from '../../../src/utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const nav = new FullNavigationStrategy();
const assetNav = new AssetNavigationStrategy();
const token = CancellationToken.None;

describe('overlayMergeDir', () => {
    it('merges at the shared boundary so a base relative dir maps onto the mod tree', () => {
        // `<mod>/common_effects` + base relative `common_effects/sounds` -> `<mod>/common_effects/sounds`.
        expect(overlayMergeDir('C:/mod/common_effects', 'common_effects/sounds')).toBe('C:/mod/common_effects/sounds');
    });

    it('appends fully when there is no shared boundary', () => {
        expect(overlayMergeDir('C:/mod/effects', 'sounds')).toBe('C:/mod/effects/sounds');
    });

    it('handles a multi-segment overlap', () => {
        expect(overlayMergeDir('C:/mod/a/b', 'a/b/c')).toBe('C:/mod/a/b/c');
    });
});

describe('inheritance-relative asset resolution', () => {
    let doc: AbstractNodeDocument;
    let soundNode: AbstractNode;

    beforeAll(async () => {
        await initWorkspace();
        doc = await parseFilePath(workspaceFile('effects', 'inherits_audio.rules'));
        const mySound = findNodeByIdentifier(doc, 'MySound')!;
        // the `Sound = "fx/beep.wav"` value node
        soundNode = (mySound as { elements: { type: string; left?: { name: string }; right: AbstractNode }[] }).elements.find(
            (e) => e.type === 'Assignment' && e.left?.name === 'Sound'
        )!.right;
    });

    it('does NOT find the asset relative to the inheriting file itself', async () => {
        // Data/effects/fx/beep.wav does not exist.
        const found = await assetNav.navigate('fx/beep.wav', soundNode, doc.uri).catch(() => false);
        expect(found).toBe(false);
    });

    it('derives the base directory from the inherited base (via a whole-file /BASE_AUDIO ref)', async () => {
        const dirs = await assetBaseDirsFromInheritance(
            soundNode,
            doc.uri,
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
            nav.navigate.bind(nav),
            token
        );
        // One candidate must be the base file's directory (…/Data/sounds).
        expect(dirs.some((d) => d.endsWith('/sounds'))).toBe(true);
    });

    it('finds the asset relative to the inherited base directory', async () => {
        const dirs = await assetBaseDirsFromInheritance(
            soundNode,
            doc.uri,
            CosmoteerWorkspaceService.instance.CosmoteerWorkspacePath,
            nav.navigate.bind(nav),
            token
        );
        let found = false;
        for (const dir of dirs) {
            if (await assetNav.navigate('fx/beep.wav', soundNode, dir + '/_').catch(() => false)) {
                found = true;
                break;
            }
        }
        expect(found).toBe(true);
    });

    it('resolves a whole-file reference INTO the file and continues the path (/BASE_AUDIO/BaseAudio)', async () => {
        const base = await nav.navigate('/BASE_AUDIO/BaseAudio', doc, doc.uri, token);
        expect(base && 'identifier' in base && base.identifier?.name).toBe('BaseAudio');
        expect(getStartOfAstNode(base as AbstractNode).uri.endsWith('base_audio.rules')).toBe(true);
    });
});
