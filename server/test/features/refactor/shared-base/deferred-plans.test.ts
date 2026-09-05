import { cpSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import { clearSharedBaseScanCache, modPlansIfBuilt } from '../../../../src/features/refactor/shared-base/mod-scan';
import { plansForDocument } from '../../../../src/features/refactor/shared-base/shared-base.analysis-entry';
import { parseText } from '../../../../src/utils/ast.utils';
import { FIXTURES_DIR } from '../../../helpers';

// An open file must not wait for the whole-mod read behind the duplicate-field hint. Asked with a
// callback, the entry answers nothing while the mod's plans are still being computed, tells the
// caller when they exist, and answers them from memory from then on.
const token = CancellationToken.None;

let root: string;

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sharedbase-deferred-')).replace(/\\/g, '/');
    cpSync(join(FIXTURES_DIR, 'shared-base-existing-mod'), root, { recursive: true });
    clearSharedBaseScanCache();
});

afterAll(() => {
    clearSharedBaseScanCache();
    rmSync(root, { recursive: true, force: true });
});

describe('plansForDocument with a callback', () => {
    it('answers nothing until the plans exist, then calls back and answers them', async () => {
        const fsPath = `${root}/parts/hull_a.rules`;
        const text = readFileSync(fsPath, { encoding: 'utf-8' });
        const document = parseText(text, filePathToUri(fsPath));
        let arrived: () => void = () => undefined;
        const arrival = new Promise<void>((resolve) => (arrived = resolve));

        const first = await plansForDocument(document, text, [root], token, undefined, () => arrived());
        expect(first).toEqual([]);
        expect(modPlansIfBuilt(root)).toBeUndefined();

        await arrival;
        expect(modPlansIfBuilt(root)).toBeDefined();
        let calledAgain = false;
        const second = await plansForDocument(document, text, [root], token, undefined, () => (calledAgain = true));
        expect(second.length).toBeGreaterThan(0);
        expect(calledAgain).toBe(false);
    });
});
