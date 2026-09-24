import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { invalidateSchemaContextCache } from '../../../src/document/schema/schema-context';
import { ActionRootingIndex } from '../../../src/mod/action-rooting.index';
import { LocalizationKeyIndex } from '../../../src/features/completion/localization-key.index';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { globalSettings } from '../../../src/settings';
import { validateLocalizationKeys } from '../../../src/features/diagnostics/validator.localization-key';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

// A manifest is a data document for this check. An inline `ToAdd` payload types from the slot its
// action targets, so a `NameKey` written there is the same field it would be in a part file, and
// the game shows the bare key text when no strings file declares it.
const token = CancellationToken.None;
let modDir = '';

const manifest = (...keys: string[]): string =>
    [
        'ID = test.manifestkeys',
        'Name = "Manifest keys fixture"',
        'Actions',
        '[',
        ...keys.flatMap((key) => [
            '\t{',
            '\t\tAction = Add',
            '\t\tAddTo = "<parts/stats_part.rules>/Part/StatsByCategory"',
            '\t\tToAdd',
            '\t\t{',
            `\t\t\tNameKey = "${key}"`,
            '\t\t}',
            '\t}',
        ]),
        ']',
        '',
    ].join('\n');

/** The findings the written manifest produces, read the way the server reads a manifest. */
const findings = async (...keys: string[]): Promise<string[]> => {
    writeFileSync(join(modDir, 'mod.rules'), manifest(...keys), 'utf8');
    clearModRootCache();
    invalidateModContext();
    ActionRootingIndex.instance.reset();
    LocalizationKeyIndex.instance.reset();
    await ActionRootingIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, modDir], token);
    invalidateSchemaContextCache();
    const document = await parseFilePath(join(modDir, 'mod.rules'));
    const errors = await validateLocalizationKeys(document, [WORKSPACE_DATA_DIR, modDir], token);
    return errors.map((error) => String(error.additionalInfo ?? error.message));
};

describe('localization keys written inside a manifest', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        modDir = mkdtempSync(join(tmpdir(), 'manifestkeys-')).split('\\').join('/');
    });

    afterAll(() => {
        ActionRootingIndex.instance.reset();
        LocalizationKeyIndex.instance.reset();
        invalidateSchemaContextCache();
        if (modDir) rmSync(modDir, { recursive: true, force: true });
    });

    it('flags a key no strings file declares', async () => {
        const found = await findings('StatsCategories/NoSuchKey');
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('StatsCategories/NoSuchKey');
    });

    it('leaves a key the strings files do declare alone', async () => {
        expect(await findings('Greeting')).toEqual([]);
    });
});
