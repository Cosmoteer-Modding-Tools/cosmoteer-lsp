import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import { ActionRootingIndex } from '../../../src/mod/action-rooting.index';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { invalidateSchemaContextCache } from '../../../src/document/schema/schema-context';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

// A manifest used to be exempt from the content checks as a whole file, which left the content a
// mod installs unjudged although the action-rooting index types it from its target slot. The verbs
// and targets around that content belong to no schema class and have to stay unjudged.
const token = CancellationToken.None;

/** A manifest whose single action carries the given entry lines. */
const manifest = (entry: string[]): string =>
    [
        'ID = test.manifestpayload',
        'Name = "Manifest payload fixture"',
        'Actions',
        '[',
        '\t{',
        ...entry.map((line) => '\t\t' + line),
        '\t}',
        ']',
        '',
    ].join('\n');

/** An `Add` action installing an inline payload into the fixture part's `list<PartStatsCategory>`. */
const addAction = (payload: string[]): string[] => [
    'Action = Add',
    'AddTo = "<parts/stats_part.rules>/Part/StatsByCategory"',
    'ToAdd',
    '{',
    ...payload.map((line) => '\t' + line),
    '}',
];

/** An `Overrides` action patching the fixture part itself with an inline payload. */
const overridesAction = (payload: string[]): string[] => [
    'Action = Overrides',
    'OverrideIn = "<parts/stats_part.rules>/Part"',
    'Overrides',
    '{',
    ...payload.map((line) => '\t' + line),
    '}',
];

type Pass = (source: string, uri: string) => Promise<{ message: string }[]>;

/** Writes the manifest into a mod of its own, roots it, and runs one pass over it. */
const findings = async (entry: string[], pass: Pass): Promise<string[]> => {
    const dir = mkdtempSync(join(tmpdir(), 'manifest-payload-'));
    try {
        const source = manifest(entry);
        const path = join(dir, 'mod.rules');
        writeFileSync(path, source);
        clearModRootCache();
        invalidateModContext();
        ActionRootingIndex.instance.reset();
        await ActionRootingIndex.instance.ensureBuilt([WORKSPACE_DATA_DIR, dir], token);
        invalidateSchemaContextCache();
        return (await pass(source, pathToFileURL(path).href)).map((error) => error.message);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

const ignoredFields: Pass = async (source, uri) => validateIgnoredFields(parser(lexer(source), uri).value, token);
const schemaChecks: Pass = async (source, uri) => validateSchema(parser(lexer(source), uri).value, token);

describe('the content a mod action installs, written inline in the manifest', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    afterEach(() => {
        ActionRootingIndex.instance.reset();
        invalidateSchemaContextCache();
    });

    afterAll(() => {
        clearModRootCache();
        invalidateModContext();
    });

    it('flags a member the installed class does not have', async () => {
        const found = await findings(
            addAction(['NameKey = "StatsCategories/Added"', 'ZzNotAStatsMember = 1']),
            ignoredFields
        );
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('ZzNotAStatsMember');
        expect(found[0]).toContain('PartStatsCategory');
    });

    it('says nothing about a payload written with the members the class has', async () => {
        expect(await findings(addAction(['NameKey = "StatsCategories/Added"']), ignoredFields)).toEqual([]);
    });

    it('says nothing about the action grammar the payload is wrapped in', async () => {
        // `Action`, `AddTo` and `ToAdd` are the mod loader's own vocabulary and belong to no schema
        // class, so the groups holding them resolve to nothing and every one of them stays unjudged.
        const found = await findings(addAction(['NameKey = "StatsCategories/Added"']), ignoredFields);
        expect(found.join('\n')).not.toContain('AddTo');
        expect(found.join('\n')).not.toContain('Action');
    });

    it('reports a field the game renamed, in the words the target file would get', async () => {
        const found = await findings(overridesAction(['CreatePartWhenDestroyed = cosmoteer.debris']), schemaChecks);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('UnderlyingPart');
    });

    it('says nothing about the same override written with the current name', async () => {
        expect(await findings(overridesAction(['UnderlyingPart = cosmoteer.debris']), schemaChecks)).toEqual([]);
    });
});
