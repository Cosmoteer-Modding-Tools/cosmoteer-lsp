import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { ReverseIncludeIndex } from '../../../src/features/navigation/reverse-include.index';
import { SchemaIdIndex } from '../../../src/features/completion/schema-id.index';
import { globalSettings } from '../../../src/settings';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const token = CancellationToken.None;
const MOD_DIR = join(FIXTURES_DIR, 'duplicate-source-mod');
const RESOURCE_CLASS = 'Cosmoteer.Resources.ResourceRules';
const SHARED_ID = 'test.shared.resource';
const uriOf = (name: string) => pathToFileURL(join(MOD_DIR, 'resources', name)).href;

// Two files of this mod declare the same id, which the game answers by keeping one of them. The
// index has to answer for both of them all the same: dropping the file it happened to record last
// used to take the id with it, so every reference to an id another file still declares started
// reading as unknown until the whole project was walked again.
describe('an id two files declare', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        SchemaIdIndex.instance.reset();
        await SchemaIdIndex.instance.idsForClass(RESOURCE_CLASS, [WORKSPACE_DATA_DIR, MOD_DIR], token);
    });

    afterAll(() => {
        SchemaIdIndex.instance.reset();
    });

    it('is known while both files are there', async () => {
        const ids = await SchemaIdIndex.instance.idsForClass(RESOURCE_CLASS, [WORKSPACE_DATA_DIR, MOD_DIR], token);
        expect(ids.has(SHARED_ID)).toBe(true);
    });

    it('stays known when either one of them is dropped', async () => {
        SchemaIdIndex.instance.remove(uriOf('second.rules'));
        expect((await SchemaIdIndex.instance.idsForClass(RESOURCE_CLASS, [WORKSPACE_DATA_DIR, MOD_DIR], token)).has(SHARED_ID)).toBe(
            true
        );
        SchemaIdIndex.instance.remove(uriOf('first.rules'));
        expect((await SchemaIdIndex.instance.idsForClass(RESOURCE_CLASS, [WORKSPACE_DATA_DIR, MOD_DIR], token)).has(SHARED_ID)).toBe(
            false
        );
    });
});

// A mod keeps a bullet beside the weapon that fires it, so nothing but the `Bullet = &<bolt.rules>`
// field says what the file is. The game reads it as the slot declares, and the id has to be
// harvested the same way or the mod's own bullets are missing from everything that reads the
// project's ids.
describe('a declaration rooted only by the field that names it', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        ReverseIncludeIndex.instance.reset();
        SchemaIdIndex.instance.reset();
        await ReverseIncludeIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, MOD_DIR], token);
    });

    afterAll(() => {
        ReverseIncludeIndex.instance.reset();
        SchemaIdIndex.instance.reset();
    });

    it('has its id harvested for the class the slot declares', async () => {
        const ids = await SchemaIdIndex.instance.primaryIdsForClass(
            'Cosmoteer.Bullets.BulletRules',
            [WORKSPACE_DATA_DIR, MOD_DIR],
            token
        );
        expect(ids.has('test.bolt')).toBe(true);
    });
});
