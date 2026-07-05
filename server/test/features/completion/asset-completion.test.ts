import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, ValueNode } from '../../../src/core/ast/ast';
import { AssetAutoCompletionStrategy } from '../../../src/features/completion/strategy/asset.autocompletion-strategy';
import { AutoCompletionAsset } from '../../../src/features/completion/autocompletion.asset';
import { Completion } from '../../../src/features/completion/autocompletion.service';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const strategy = new AssetAutoCompletionStrategy();
const ASSETS_URI = workspaceFile('effects', 'assets.rules').replace(/\\/g, '/');

/** A synthetic asset value node anchored at the effects fixture file. */
const assetValue = (value: string, type: 'Sprite' | 'Sound' | 'String' = 'Sprite'): ValueNode => {
    const doc = { type: 'Document', elements: [], uri: ASSETS_URI } as unknown as AbstractNodeDocument;
    return {
        type: 'Value',
        valueType: { type, value } as ValueNode['valueType'],
        quoted: true,
        parent: doc,
        position: { line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 },
    } as ValueNode;
};

const labels = (completions: Completion[]): string[] =>
    completions.map((completion) => (typeof completion === 'string' ? completion : completion.label));

describe('AssetAutoCompletionStrategy', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('lists sibling sprite files in the current directory', async () => {
        const result = await strategy.complete({ node: assetValue(''), cancellationToken: token });
        expect(labels(result)).toContain('spark.png');
    });

    it('offers the ./Data/ root prefix from an empty value', async () => {
        const result = await strategy.complete({ node: assetValue(''), cancellationToken: token });
        expect(labels(result)).toContain('./Data/');
    });

    it('filters by the partially typed filename', async () => {
        const result = await strategy.complete({ node: assetValue('spa'), cancellationToken: token });
        expect(labels(result)).toContain('spark.png');
    });

    it('drills into a sibling directory across a slash', async () => {
        const result = await strategy.complete({ node: assetValue('../sounds/', 'Sound'), cancellationToken: token });
        // fx/ is a sub-directory of ../sounds containing beep.wav
        expect(labels(result)).toContain('fx/');
    });

    it('resolves directories under the ./Data/ root', async () => {
        const result = await strategy.complete({ node: assetValue('./Data/sounds/fx/', 'Sound'), cancellationToken: token });
        expect(labels(result)).toContain('beep.wav');
    });

    it('filters by the schema-supplied assetType even when the value text is unclassified', async () => {
        // A still-extension-less String value: without a type hint it would offer every asset kind,
        // but a schema `assetType` (e.g. the field is a Sound) narrows the listing to that kind, so
        // the sibling sprite (`spark.png`) is NOT offered for a sound-typed field.
        const value = assetValue('', 'String');
        const asSound = await strategy.complete({ node: value, cancellationToken: token, assetType: 'Sound' });
        expect(labels(asSound)).not.toContain('spark.png');
        const asSprite = await strategy.complete({ node: value, cancellationToken: token, assetType: 'Sprite' });
        expect(labels(asSprite)).toContain('spark.png');
    });
});

describe('AutoCompletionAsset (the trigger gate)', () => {
    const completer = new AutoCompletionAsset();
    /** A value node with explicit quoting, anchored at the effects fixture file. */
    const node = (value: string, type: 'Sprite' | 'Sound' | 'Shader' | 'String', quoted: boolean): ValueNode => {
        const n = assetValue(value, type as 'Sprite');
        (n as { quoted: boolean }).quoted = quoted;
        return n;
    };

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('fires on an UNQUOTED already-classified asset (e.g. `File = part.png` inside a group)', async () => {
        // The reported case: vanilla/mods write `Shader { File = x.shader }` / `Sprite = part.png`
        // unquoted, and asset-path completion must still offer the sibling files.
        const result = await completer.getCompletions(node('', 'Sprite', false), token);
        expect(labels(result)).toContain('spark.png');
    });

    it('fires on a QUOTED string that already looks like a path', async () => {
        const result = await completer.getCompletions(node('../sounds/', 'String', true), token);
        expect(labels(result)).toContain('fx/');
    });

    it('does NOT fire on an unquoted plain string (an ordinary identifier/name)', async () => {
        const result = await completer.getCompletions(node('SomeName', 'String', false), token);
        expect(result).toEqual([]);
    });
});
