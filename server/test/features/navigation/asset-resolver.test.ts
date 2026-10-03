import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { resolveAssetPath, suggestAssetFilename } from '../../../src/features/navigation/asset-resolver';
import { AbstractNode, AbstractNodeDocument, isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { findNodeByIdentifier, walkAst } from '../../helpers';
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

    it("does not find an asset in the folder of an inherited base, only in the declaring file's own folder", async () => {
        // Data/sounds/fx/beep.wav exists beside the base and Data/effects/fx/beep.wav does not. The
        // game combines the path with the declaring file's directory and looks nowhere else.
        expect(await resolveAssetPath(soundNode, doc.uri, token)).toBeNull();
    });

    it('suggests the same path under the sub-folder of the declaring directory that holds it', async () => {
        // Data/effects/audio/fx/beep.wav is the copy that came along with the copied definition.
        expect(await suggestAssetFilename(soundNode, doc.uri, token)).toBe('audio/fx/beep.wav');
    });
});

describe('an asset left behind in the folder above', () => {
    let root: string;
    let uri: string;
    let node: ValueNode;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'asset-above-'));
        mkdirSync(join(root, 'small', 'overclock'), { recursive: true });
        writeFileSync(join(root, 'small', 'blue_laser.png'), '');
        uri = pathToFileURL(join(root, 'small', 'overclock', 'oc_blue_shot.rules')).href;
        const document = parser(lexer('Texture { File = "blue_laser.png" }\n'), uri).value;
        node = [...walkAst(document)].find(
            (candidate): candidate is ValueNode => isValueNode(candidate) && candidate.valueType.type === 'Sprite'
        )!;
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    // A definition copied into a sub-folder keeps the path that worked one level up.
    it('suggests the path that climbs to it', async () => {
        expect(await suggestAssetFilename(node, uri, token)).toBe('../blue_laser.png');
    });
});
