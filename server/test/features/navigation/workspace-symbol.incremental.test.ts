import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import { WorkspaceSymbolService } from '../../../src/features/navigation/workspace-symbol.service';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

// The cached symbol table is built once, then kept current by the watcher signals
// (markDirty / remove) — NOT re-parsed per query. This proves a disk change the editor
// never reported still shows up. Temp file lives in an isolated dir (an extra scanned
// folder), never the shared fixtures, so it can't race other suites.
const service = WorkspaceSymbolService.instance;
const token = CancellationToken.None;
const TMP_DIR = mkdtempSync(join(tmpdir(), 'cosmo-sym-'));
const FOLDERS = [WORKSPACE_DATA_DIR, TMP_DIR];
const NEW_FILE = join(TMP_DIR, '_tmp_symbol.rules');

describe('WorkspaceSymbolService — cached + incremental', () => {
    beforeAll(async () => {
        await initWorkspace();
        service.reset();
    });

    afterAll(() => {
        rmSync(TMP_DIR, { recursive: true, force: true });
    });

    it('reflects a file created on disk after the initial build, then its deletion', async () => {
        // Initial build, before the file exists: the symbol is absent.
        expect((await service.getWorkspaceSymbols('PulledSymbol', FOLDERS, token)).length).toBe(0);

        // `git pull` adds a file the editor never opened → watcher markDirty → reconcile.
        writeFileSync(NEW_FILE, 'PulledSymbol\n{\n\tInner = 1\n}\n', 'utf-8');
        service.markDirty(NEW_FILE);

        const after = await service.getWorkspaceSymbols('PulledSymbol', FOLDERS, token);
        expect(after.some((s) => s.name === 'PulledSymbol' && s.location.uri.endsWith('_tmp_symbol.rules'))).toBe(true);

        // Deletion drops it.
        unlinkSync(NEW_FILE);
        service.remove(NEW_FILE);
        expect((await service.getWorkspaceSymbols('PulledSymbol', FOLDERS, token)).length).toBe(0);
    });
});
