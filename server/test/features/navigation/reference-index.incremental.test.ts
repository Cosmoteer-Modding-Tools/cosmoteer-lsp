import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import { ReferenceIndex } from '../../../src/features/navigation/reference-index';
import { AbstractNodeDocument, isAssignmentNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { walkAst } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

// find-all-references is STATELESS — it re-reads buffers/disk per query — so it reflects
// disk changes (a new file from `git pull`, a deletion) with no cache to invalidate. The
// new file lives in an ISOLATED temp dir (an extra scanned folder), never the shared
// fixtures, so this can't race other suites.
const index = ReferenceIndex.instance;
const token = CancellationToken.None;
const TMP_DIR = mkdtempSync(join(tmpdir(), 'cosmo-ref-'));
const FOLDERS = [WORKSPACE_DATA_DIR, TMP_DIR];
const NEW_FILE = join(TMP_DIR, '_tmp_pulled.rules');
const NEW_FILE_CONTENT = 'Pulled\n{\n\tRef = &<./Data/b.rules>/B/InnerValue\n}\n';

const innerValuePosition = (b: AbstractNodeDocument) => {
    for (const node of walkAst(b))
        if (isAssignmentNode(node) && node.left.name === 'InnerValue')
            return { line: node.left.position.line, character: node.left.position.characterStart };
    throw new Error('InnerValue not found');
};

describe('find-all-references — reflects disk changes (stateless)', () => {
    let bDoc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        if (existsSync(NEW_FILE)) unlinkSync(NEW_FILE);
        bDoc = await parseFilePath(workspaceFile('b.rules'));
    });

    afterAll(() => {
        rmSync(TMP_DIR, { recursive: true, force: true });
    });

    it('picks up a file created on disk (no cache to invalidate)', async () => {
        const position = innerValuePosition(bDoc);

        // Before the file exists: only a.rules references InnerValue.
        const before = await index.findReferences(bDoc, position, false, FOLDERS, token);
        expect(before.length).toBe(1);

        // A file the editor never opened (e.g. from `git pull`).
        writeFileSync(NEW_FILE, NEW_FILE_CONTENT, 'utf-8');

        const after = await index.findReferences(bDoc, position, false, FOLDERS, token);
        expect(after.length).toBe(2);
        expect(after.some((r) => r.uri.endsWith('_tmp_pulled.rules'))).toBe(true);
    });

    it('drops a deleted file’s references', async () => {
        const position = innerValuePosition(bDoc);
        unlinkSync(NEW_FILE);

        const after = await index.findReferences(bDoc, position, false, FOLDERS, token);
        expect(after.length).toBe(1);
        expect(after.some((r) => r.uri.endsWith('_tmp_pulled.rules'))).toBe(false);
    });
});
