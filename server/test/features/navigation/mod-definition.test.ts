import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { DefinitionService } from '../../../src/features/navigation/definition.service';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';
import { FIXTURES_DIR, findReferenceNode } from '../../helpers';

// Go-to-definition on a `mod.rules` manifest's ACTION TARGETS — paths like
// `<cosmoteer.rules>/FOO` that name a location in the EFFECTIVE game tree (vanilla +
// what the mod inserts), not a path relative to the manifest. These need the canonical
// `<./Data/…>` rewrite + mod-context fallback, which raw navigation does not do.
const service = DefinitionService.instance;
const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'mod');

const cursorOn = (node: { position: { line: number; characterStart: number } }) => ({
    line: node.position.line,
    character: node.position.characterStart,
});

describe('DefinitionService — mod-action targets', () => {
    let manifest: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        manifest = await parseFilePath(join(MOD_DIR, 'mod.rules'));
    });

    it('jumps to a mod-INSERTED global referenced as a target (`OverrideIn = <cosmoteer.rules>/FOO`)', async () => {
        // FOO is not in vanilla cosmoteer.rules; the manifest's `Add` action injects it,
        // sourced from provider.rules. Go-to-def must follow it there.
        const ref = findReferenceNode(manifest, '<cosmoteer.rules>/FOO');
        const location = await service.getDefinition(manifest, cursorOn(ref), token);

        expect(location).not.toBeNull();
        expect(location!.uri.endsWith('provider.rules')).toBe(true);
    });

    it('resolves a whole-file target (`AddTo = <cosmoteer.rules>`) to the game cosmoteer.rules', async () => {
        const ref = findReferenceNode(manifest, '<cosmoteer.rules>');
        const location = await service.getDefinition(manifest, cursorOn(ref), token);

        expect(location).not.toBeNull();
        expect(location!.uri.endsWith('cosmoteer.rules')).toBe(true);
        expect(location!.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    });

    it('jumps through a super-path into a mod-inserted global from a DATA file (`&/GLOBAL_TWO/Bar`)', async () => {
        // A normal data file inside the mod (not a manifest). `&/GLOBAL_TWO/Bar` resolves
        // only in the mod's effective tree; the prefix loop must not stop at a bare `&`.
        const dataFile = await parseFilePath(join(MOD_DIR, 'consumer.rules'));
        const ref = findReferenceNode(dataFile, '&/GLOBAL_TWO/Bar');
        const location = await service.getDefinition(dataFile, cursorOn(ref), token);

        expect(location).not.toBeNull();
        expect(location!.uri.endsWith('provider.rules')).toBe(true);
    });

    it('jumps to the mod OVERRIDE source for a member merged into a vanilla file (`&/INDICATORS/SWNoShields`)', async () => {
        // The member lives only in the mod's override source (mod_indicators.rules), merged into the
        // vanilla indicators file that `INDICATORS` aliases. The mod-context resolution of the FULL
        // path must run BEFORE the prefix walk, or go-to-def stops at the vanilla file (prefix
        // `/INDICATORS`) and never reaches the actual member.
        const dataFile = await parseFilePath(join(MOD_DIR, 'consumer.rules'));
        const ref = findReferenceNode(dataFile, '&/INDICATORS/SWNoShields');
        const location = await service.getDefinition(dataFile, cursorOn(ref), token);

        expect(location).not.toBeNull();
        expect(location!.uri.endsWith('mod_indicators.rules')).toBe(true);
    });
});
