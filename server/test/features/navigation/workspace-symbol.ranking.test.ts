import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CancellationToken } from 'vscode-languageserver';
import { WorkspaceSymbolService } from '../../../src/features/navigation/workspace-symbol.service';

// A common field name matches more symbols than one answer can carry, so what the cut keeps decides
// whether the name the author typed is reachable at all. The generated project holds far more
// substring matches than the cap, written into the file the walk reads first, and the one symbol
// named exactly what is typed in the file it reads last.
const token = CancellationToken.None;
const service = WorkspaceSymbolService.instance;
const BULK = 2500;
let folder: string;

beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'cosmoteer-symbols-'));
    const bulk = ['Bulk', '{'];
    for (let index = 0; index < BULK; index++) bulk.push(`\tDamageLevels${index} = ${index}`);
    bulk.push('}', '');
    writeFileSync(join(folder, 'a_bulk.rules'), bulk.join('\n'), 'utf8');
    writeFileSync(join(folder, 'z_exact.rules'), ['Part', '{', '\tDamage = 3', '}', ''].join('\n'), 'utf8');
    service.reset();
});

afterAll(() => {
    service.reset();
    rmSync(folder, { recursive: true, force: true });
});

describe('the symbols a workspace query answers', () => {
    it('answers the symbol named exactly what was typed before thousands that merely contain it', async () => {
        const symbols = await service.getWorkspaceSymbols('damage', [folder], token);
        expect(symbols[0].name).toBe('Damage');
        expect(symbols.some((symbol) => symbol.name === 'Damage')).toBe(true);
    });

    it('answers a name that starts with what was typed before one that carries it in the middle', async () => {
        const symbols = await service.getWorkspaceSymbols('damagelevels1', [folder], token);
        expect(symbols[0].name).toBe('DamageLevels1');
    });

    it('answers nothing for a name the project does not write', async () => {
        expect(await service.getWorkspaceSymbols('no_such_symbol_here', [folder], token)).toEqual([]);
    });

    it('still answers the whole project for an empty query', async () => {
        const symbols = await service.getWorkspaceSymbols('', [folder], token);
        expect(symbols.length).toBeGreaterThan(10);
    });
});
