import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import * as astUtils from '../../../src/utils/ast.utils';
import { projectDocuments } from '../../../src/features/navigation/workspace-files';

// Regression: one unparseable file (the parser still THROWS on some constructs, e.g.
// `inferValueType`) must NOT abort the whole project walk — otherwise it silently kills
// find-all-references / rename / workspace symbols for the ENTIRE project.
const token = CancellationToken.None;
const DIR = mkdtempSync(join(tmpdir(), 'cosmo-resilient-'));
const GOOD = join(DIR, 'good.rules');
const BAD = join(DIR, 'bad.rules');

describe('projectDocuments — resilient to an unparseable file', () => {
    beforeAll(() => {
        writeFileSync(GOOD, 'Good\n{\n\tValue = 1\n}\n', 'utf-8');
        writeFileSync(BAD, 'Bad\n{\n\tBoom = 1\n}\n', 'utf-8');
    });

    afterAll(() => {
        rmSync(DIR, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('skips the throwing file and still yields the parseable ones', async () => {
        const realParse = astUtils.parseFilePath;
        vi.spyOn(astUtils, 'parseFilePath').mockImplementation(async (path: string, cancel) => {
            if (path.endsWith('bad.rules')) throw new Error('Token value is undefined');
            return realParse(path, cancel);
        });

        const documents = [];
        for await (const document of projectDocuments([DIR], token)) documents.push(document);

        expect(documents.some((d) => d.uri.endsWith('good.rules'))).toBe(true);
        expect(documents.some((d) => d.uri.endsWith('bad.rules'))).toBe(false);
    });
});
