import { readFileSync } from 'fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Position } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, AbstractNodeDocument, isValueNode, ValueNode } from '../../../src/core/ast/ast';
import { AssetNavigationStrategy } from '../../../src/features/navigation/asset.navigation-strategy';
import { DefinitionService } from '../../../src/features/navigation/definition.service';
import { HoverService } from '../../../src/features/hover/hover.service';
import { globalSettings } from '../../../src/settings';
import { walkAst } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
// Asset resolution mirrors the existing asset tests: a forward-slash URI (the casing the
// real LSP receives), so `filePathToDirectoryPath` finds the directory cleanly on Windows.
const ASSETS_URI = workspaceFile('effects', 'assets.rules').replace(/\\/g, '/');

const assetNode = (doc: AbstractNodeDocument, value: string): ValueNode => {
    for (const node of walkAst(doc)) {
        if (isValueNode(node) && 'value' in node.valueType && node.valueType.value === value) return node;
    }
    throw new Error(`No value node found for "${value}"`);
};

const cursorOn = (node: AbstractNode): Position =>
    Position.create(node.position.line, node.position.characterStart);

describe('asset features', () => {
    let doc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        doc = parser(lexer(readFileSync(ASSETS_URI, 'utf-8')), ASSETS_URI).value;
    });

    describe('AssetNavigationStrategy.resolveAsset', () => {
        const nav = new AssetNavigationStrategy();

        it('resolves a sibling sprite to its absolute path', async () => {
            const path = await nav.resolveAsset('spark.png', assetNode(doc, 'spark.png'), ASSETS_URI);
            expect(path).not.toBeNull();
            expect(path!.replace(/\\/g, '/').endsWith('effects/spark.png')).toBe(true);
        });

        it('resolves a relative sound across directories', async () => {
            const path = await nav.resolveAsset('../sounds/fx/beep.wav', assetNode(doc, '../sounds/fx/beep.wav'), ASSETS_URI);
            expect(path).not.toBeNull();
            expect(path!.replace(/\\/g, '/').endsWith('sounds/fx/beep.wav')).toBe(true);
        });

        it('resolves a `./Data/...` absolute path (case-insensitive)', async () => {
            const path = await nav.resolveAsset('./data/sounds/fx/beep.wav', assetNode(doc, 'spark.png'), ASSETS_URI);
            expect(path).not.toBeNull();
        });

        it('returns null for a missing asset', async () => {
            const path = await nav.resolveAsset('sparkk.png', assetNode(doc, 'sparkk.png'), ASSETS_URI);
            expect(path).toBeNull();
        });
    });

    describe('go-to-definition', () => {
        it('jumps to the sprite file on disk', async () => {
            const location = await DefinitionService.instance.getDefinition(doc, cursorOn(assetNode(doc, 'spark.png')), token);
            expect(location).not.toBeNull();
            expect(location!.uri.endsWith('spark.png')).toBe(true);
            expect(location!.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
        });

        it('jumps to a relative sound file', async () => {
            const location = await DefinitionService.instance.getDefinition(doc, cursorOn(assetNode(doc, '../sounds/fx/beep.wav')), token);
            expect(location).not.toBeNull();
            expect(location!.uri.endsWith('beep.wav')).toBe(true);
        });

        it('returns null for a missing asset', async () => {
            const location = await DefinitionService.instance.getDefinition(doc, cursorOn(assetNode(doc, 'sparkk.png')), token);
            expect(location).toBeNull();
        });
    });

    describe('hover', () => {
        const hoverText = async (value: string): Promise<string> => {
            const hover = await HoverService.instance.getHover(doc, cursorOn(assetNode(doc, value)), token);
            return hover ? (hover.contents as { value: string }).value : '';
        };

        it('shows a found sprite with an inline image preview', async () => {
            const text = await hoverText('spark.png');
            expect(text).toContain('Sprite');
            expect(text).toContain('found');
            expect(text).toContain('spark.png');
            expect(text).toContain('![preview]'); // image markdown
        });

        it('shows a found sound without an image preview', async () => {
            const text = await hoverText('../sounds/fx/beep.wav');
            expect(text).toContain('Sound');
            expect(text).toContain('found');
            expect(text).not.toContain('![preview]');
        });

        it('reports a missing asset as not found', async () => {
            const text = await hoverText('sparkk.png');
            expect(text).toContain('not found');
        });
    });
});
