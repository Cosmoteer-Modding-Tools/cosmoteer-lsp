import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, SymbolKind } from 'vscode-languageserver';
import { WorkspaceSymbolService } from '../../../src/features/navigation/workspace-symbol.service';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const service = WorkspaceSymbolService.instance;
const token = CancellationToken.None;
const FOLDERS = [WORKSPACE_DATA_DIR];

describe('WorkspaceSymbolService: go-to-symbol-in-workspace', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('finds a named assignment across the project and reports its container', async () => {
        const symbols = await service.getWorkspaceSymbols('InnerValue', FOLDERS, token);

        const inner = symbols.find((s) => s.name === 'InnerValue' && s.location.uri.endsWith('b.rules'));
        expect(inner).toBeTruthy();
        expect(inner!.kind).toBe(SymbolKind.Number); // InnerValue = 100
        expect(inner!.containerName).toBe('B'); // nested under group B
    });

    it('finds an identified group and keys it as an Object symbol', async () => {
        const symbols = await service.getWorkspaceSymbols('B', FOLDERS, token);

        const groupB = symbols.find((s) => s.name === 'B' && s.location.uri.endsWith('b.rules'));
        expect(groupB).toBeTruthy();
        expect(groupB!.kind).toBe(SymbolKind.Object);
    });

    it('substring-matches case-insensitively', async () => {
        const symbols = await service.getWorkspaceSymbols('inner', FOLDERS, token);
        expect(symbols.some((s) => s.name === 'InnerValue')).toBe(true);
    });

    it('an empty query returns the whole project symbol set', async () => {
        const symbols = await service.getWorkspaceSymbols('', FOLDERS, token);
        // At least the handful of named members across the fixture files.
        expect(symbols.length).toBeGreaterThan(5);
        expect(symbols.some((s) => s.name === 'InnerValue')).toBe(true);
        expect(symbols.some((s) => s.name === 'Nested')).toBe(true);
    });
});
