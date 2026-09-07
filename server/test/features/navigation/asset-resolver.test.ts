import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { resolveAssetPath, suggestAssetFilename } from '../../../src/features/navigation/asset-resolver';
import { AbstractNode, AbstractNodeDocument, ValueNode } from '../../../src/core/ast/ast';
import { findNodeByIdentifier, parseFilePath } from '../../../src/utils/ast.utils';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

describe('asset resolution follows the game', () => {
    let doc: AbstractNodeDocument;
    let soundNode: ValueNode;

    beforeAll(async () => {
        await initWorkspace();
        doc = await parseFilePath(workspaceFile('effects', 'inherits_audio.rules'));
        const mySound = findNodeByIdentifier(doc, 'MySound')!;
        // The `Sound = "fx/beep.wav"` value node.
        soundNode = (
            mySound as unknown as { elements: { type: string; left?: { name: string }; right: AbstractNode }[] }
        ).elements.find((e) => e.type === 'Assignment' && e.left?.name === 'Sound')!.right as ValueNode;
    });

    it('does not find an asset in the folder of an inherited base, only in the declaring file\'s own folder', async () => {
        // Data/sounds/fx/beep.wav exists beside the base and Data/effects/fx/beep.wav does not. The
        // game combines the path with the declaring file's directory and looks nowhere else.
        expect(await resolveAssetPath(soundNode, doc.uri, token)).toBeNull();
    });

    it('suggests the same path under the sub-folder of the declaring directory that holds it', async () => {
        // Data/effects/audio/fx/beep.wav is the copy that came along with the copied definition.
        expect(await suggestAssetFilename(soundNode, doc.uri, token)).toBe('audio/fx/beep.wav');
    });
});
