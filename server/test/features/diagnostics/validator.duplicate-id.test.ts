import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { invalidateSchemaContextCache } from '../../../src/document/schema/schema-context';
import { ActionRootingIndex } from '../../../src/mod/action-rooting.index';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { globalSettings } from '../../../src/settings';
import {
    invalidateDuplicateIdCache,
    validateDuplicateModIds,
} from '../../../src/features/diagnostics/validator.duplicate-id';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';
import { FIXTURES_DIR } from '../../helpers';

// The rule is narrow on purpose. `entityDeclarationsOf` is an existence harvest rather than a
// uniqueness oracle, and using it here measured 652 colliding groups on the game's own data. What
// makes a second declaration a real collision is that the game registers both of them, which is what
// separates a duplicate from an inheritance template that carries a leftover id.
const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'duplicate-id-mod');
const modFile = (name: string): string => join(MOD_DIR, name);

const findingsFor = async (name: string) =>
    validateDuplicateModIds(await parseFilePath(modFile(name)), [WORKSPACE_DATA_DIR, MOD_DIR], token);

describe('validateDuplicateModIds', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        ActionRootingIndex.instance.reset();
        await ActionRootingIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
        invalidateSchemaContextCache();
        invalidateDuplicateIdCache();
    });

    it('reports both files when the mod registers the same id twice', async () => {
        const found = await findingsFor('registered_a.rules');
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain('test.duplicate.block');
        // The finding names the other file, which is the whole point of a cross-file check.
        expect(`${found[0].message} ${found[0].additionalInfo ?? ''}`).toContain('registered_b');
    });

    it('reports the collision from the other side too', async () => {
        const found = await findingsFor('registered_b.rules');
        expect(found).toHaveLength(1);
        expect(`${found[0].message} ${found[0].additionalInfo ?? ''}`).toContain('registered_a');
    });

    it('says nothing about an id only one file declares', async () => {
        expect(await findingsFor('registered_c.rules')).toEqual([]);
    });

    it('says nothing about an inheritance template the mod never registers', async () => {
        // It carries the same id as registered_a, but nothing roots it into a game collection, so
        // the game never sees a second entry. This was every surviving hit in the workshop probe.
        expect(await findingsFor('template_base.rules')).toEqual([]);
    });

    it('says nothing about a rules-shaped file inside the strings folder', async () => {
        expect(await findingsFor('strings/en.rules')).toEqual([]);
    });
});

// A mod may ship several manifests and let the game pick the one whose CompatibleGameVersions fits,
// in which case only one of the alternative trees ever loads and the same id in both is not a
// collision. The reachability closure does not answer this: it seeds every manifest under the root on
// purpose, so both trees come back reachable. Hence the separate gate, which no installed mod
// exercises, so this fixture is the only thing covering it.
describe('validateDuplicateModIds with alternative manifests', () => {
    const VARIANT_DIR = join(FIXTURES_DIR, 'duplicate-id-variant-mod');

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        clearModRootCache();
        invalidateModContext();
        ActionRootingIndex.instance.reset();
        await ActionRootingIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, VARIANT_DIR], token);
        invalidateSchemaContextCache();
        invalidateDuplicateIdCache();
    });

    it('stays silent when the mod root holds more than one manifest', async () => {
        const document = await parseFilePath(join(VARIANT_DIR, 'variant_a.rules'));
        expect(await validateDuplicateModIds(document, [WORKSPACE_DATA_DIR, VARIANT_DIR], token)).toEqual([]);
    });
});
