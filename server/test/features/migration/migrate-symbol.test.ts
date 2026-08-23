import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, Diagnostic, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    allDeprecationSymbols,
    deprecationBySymbol,
    migrationSymbolOf,
} from '../../../src/document/schema/deprecations';
import { ValidationErrorData } from '../../../src/features/diagnostics/validator';
import { validateIgnoredFields } from '../../../src/features/diagnostics/validator.ignored-field';
import { validateSchema } from '../../../src/features/diagnostics/validator.schema';
import {
    applyMigrationChanges,
    MigrateSymbolArgs,
    MigrateSymbolHost,
    MIGRATE_SYMBOL_ACTION_COMMAND,
    migrateSymbolCodeAction,
    MigrationChange,
    narrowToSymbolScope,
} from '../../../src/features/migration/migrate-symbol';
import { collectFileMigration } from '../../../src/features/migration/migrate-workspace';
import { editableModRootOf } from '../../../src/features/refactor/shared-base/shared-base.analysis-entry';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

// The bulk deprecation fix: one lightbulb applies one registry entry to a whole mod. The value of
// the feature rests on it collecting findings by registry identity rather than by matching the old
// name as text, so most of what is pinned here is what it declines to touch.
const token = CancellationToken.None;

const FIXTURES = resolve(__dirname, '../../fixtures/migrate-symbol-mod').replace(/\\/g, '/');
const MY_MOD = `${FIXTURES}/project/mymod`;
const OTHER_MOD = `${FIXTURES}/project/othermod`;
const DATA_ROOT = `${FIXTURES}/steam/steamapps/common/Cosmoteer/Data`;
const WORKSHOP_MOD = `${FIXTURES}/steam/steamapps/workshop/content/799600/1111`;

/** Every part file of the fixture, in the order a workspace walk would hand them over. */
const ALL_FILES = [
    `${MY_MOD}/parts/thruster_a.rules`,
    `${MY_MOD}/parts/thruster_b.rules`,
    `${MY_MOD}/parts/proxy.rules`,
    `${OTHER_MOD}/parts/other_part.rules`,
    `${DATA_ROOT}/parts/vanilla_part.rules`,
    `${WORKSHOP_MOD}/parts/installed_part.rules`,
];

/** A part writing one of every reachable deprecation kind, so a partition can be checked on it. */
const EVERY_KIND = [
    'Part',
    '{',
    '\tTypeCategories = [thruster]',
    '\tFlammable = false',
    '\tCreatePartWhenDestroyed = cosmoteer.structure',
    '\tExplosiveDamageResistance = 0.4',
    '\tComponents',
    '\t{',
    '\t\tStore',
    '\t\t{',
    '\t\t\tType = AmmoStorage',
    '\t\t}',
    '\t}',
    '}',
    '',
].join('\n');

/**
 * Run the per-file migration collector over a source text.
 *
 * @param text the file's source.
 * @param options the uri to parse it as, the dead-field opt-in, and the deprecation to collect.
 * @returns the collector's result and the text its edits produce.
 */
const migrate = async (
    text: string,
    options: { uri?: string; includeDeadFields?: boolean; symbol?: string } = {}
) => {
    const uri = options.uri ?? 'file:///data/parts/t.rules';
    const doc = TextDocument.create(uri, 'rules', 0, text);
    const parserResult = parser(lexer(text), uri);
    expect(parserResult.parserErrors).toEqual([]);
    const result = await collectFileMigration(
        parserResult.value,
        doc,
        options.includeDeadFields === true,
        token,
        options.symbol
    );
    return { result, applied: TextDocument.applyEdits(doc, result.edits) };
};

/** An edit as a comparable string, so two runs can be compared without depending on their order. */
const editKeys = (edits: readonly { range: { start: { line: number; character: number } }; newText: string }[]) =>
    edits.map((edit) => `${edit.range.start.line}:${edit.range.start.character}=${edit.newText}`).sort();

/** A diagnostic carrying validation data, the shape the code-action offer reads. */
const diagnosticWith = (data: ValidationErrorData): Diagnostic => ({
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    message: 'test finding',
    data,
});

/** A stand-in for the mention index and the editable-mod gate. */
const fakeHost = (candidates: string[] | undefined, roots: Record<string, string | undefined>): MigrateSymbolHost => ({
    candidateFiles: async () => candidates,
    editableRootOf: (fsPath) => {
        for (const [root, answer] of Object.entries(roots)) {
            if (fsPath.startsWith(`${root}/`)) return answer;
        }
        return undefined;
    },
});

describe('collecting one deprecation instead of all of them', () => {
    it('applies only the named deprecation and leaves the other migrations of the file alone', async () => {
        const { result, applied } = await migrate(EVERY_KIND, {
            symbol: migrationSymbolOf('renamedAlias', 'CreatePartWhenDestroyed'),
        });
        expect(result.edits).toHaveLength(1);
        expect(applied).toContain('UnderlyingPart = cosmoteer.structure');
        // The other three deprecations of the same file are untouched: the author asked about one.
        expect(applied).toContain('Flammable = false');
        expect(applied).toContain('ExplosiveDamageResistance = 0.4');
        expect(applied).toContain('Type = AmmoStorage');
        expect(result.byVersion).toEqual({ '0.23.0': 1 });
        expect(result.manual).toEqual([]);
    });

    it('rewrites the ViaBuffs ComponentID and never the proxy element that spells it the same', async () => {
        const path = `${MY_MOD}/parts/proxy.rules`;
        const { result, applied } = await migrate(readFileSync(path, 'utf8'), {
            uri: pathToFileURL(path).href,
            symbol: migrationSymbolOf('obsoleteField', 'ComponentID'),
        });
        // `ComponentID` is a live field on a proxyable component and deprecated only on the buff
        // multi-proxy, which is the whole reason the fix collects by class rather than by name.
        expect(applied).toContain('ComponentIDs = [BeltStorages]');
        expect(applied.match(/ComponentID = BeltStorages/g)).toHaveLength(1);
        expect(result.byVersion).toEqual({ '0.26.0': 1 });
    });

    it('never removes a dead field when a deprecation was named', async () => {
        const source = 'Part\n{\n\tFireDamageFactor = 2\n\tCreatePartWhenDestroyed = cosmoteer.structure\n}\n';
        const bulk = await migrate(source, {
            includeDeadFields: true,
            symbol: migrationSymbolOf('renamedAlias', 'CreatePartWhenDestroyed'),
        });
        expect(bulk.applied).toContain('FireDamageFactor = 2');
        expect(bulk.result.deadFieldsRemoved).toBe(0);
        // Without a symbol the same call does strip it, so the guard is what makes the difference.
        const whole = await migrate(source, { includeDeadFields: true });
        expect(whole.applied).not.toContain('FireDamageFactor');
        expect(whole.result.deadFieldsRemoved).toBe(1);
    });

    it('leaves a finding that needs author judgment as a manual entry under its own symbol', async () => {
        const source = 'Part\n{\n\tDamageResistances = { explosive = 0.2 }\n\tExplosiveDamageResistance = 0.4\n}\n';
        const { result, applied } = await migrate(source, {
            symbol: migrationSymbolOf('obsoleteField', 'ExplosiveDamageResistance'),
        });
        // The successor is already written beside it, so a mechanical rewrite would produce two
        // members of the same name. Reported, never edited.
        expect(result.edits).toEqual([]);
        expect(applied).toBe(source);
        expect(result.manual).toHaveLength(1);
        expect(result.manual[0].message).toContain('DamageResistances');
    });

    it('renames the manifest flag only under the manifest symbol', async () => {
        const source = 'ID = my.mod\nName = "My Mod"\nModifiesMultiplayer = true\n';
        const uri = 'file:///mod/mod.rules';
        const mine = await migrate(source, { uri, symbol: migrationSymbolOf('manifestField', 'ModifiesMultiplayer') });
        expect(mine.applied).toContain('ModifiesGameplay = true');
        const other = await migrate(source, { uri, symbol: migrationSymbolOf('renamedAlias', 'CreatePartWhenDestroyed') });
        expect(other.result.edits).toEqual([]);
        expect(other.applied).toBe(source);
    });

    it('tags every migration finding with a registry identity', async () => {
        const uri = 'file:///data/parts/t.rules';
        const parserResult = parser(lexer(EVERY_KIND), uri);
        const errors = [
            ...(await validateSchema(parserResult.value, token)),
            ...(await validateIgnoredFields(parserResult.value, token)),
        ];
        const migrations = errors.filter((error) => error.data?.migration);
        expect(migrations.length).toBeGreaterThanOrEqual(4);
        for (const error of migrations) {
            const symbol = error.data?.migration?.symbol;
            expect(symbol, `untagged migration finding: ${error.message}`).toBeDefined();
            expect(deprecationBySymbol(symbol!), `unknown symbol ${symbol}`).toBeDefined();
        }
    });

    it('adds the per-symbol runs back up to the unfiltered one', async () => {
        const whole = await migrate(EVERY_KIND);
        const edits: string[] = [];
        const manual: string[] = [];
        let fixes = 0;
        for (const symbol of allDeprecationSymbols()) {
            const one = await migrate(EVERY_KIND, { symbol });
            edits.push(...editKeys(one.result.edits));
            manual.push(...one.result.manual.map((finding) => finding.message));
            fixes += Object.values(one.result.byVersion).reduce((a, b) => a + b, 0);
        }
        // Nothing collected twice and nothing dropped: this is the invariant that stops the next
        // deprecation entry shipping without an identity, which would make it unreachable in bulk.
        expect(edits.sort()).toEqual(editKeys(whole.result.edits));
        expect(manual.sort()).toEqual(whole.result.manual.map((finding) => finding.message).sort());
        expect(fixes).toBe(Object.values(whole.result.byVersion).reduce((a, b) => a + b, 0));
    });
});

describe('the offer on the lightbulb', () => {
    const uri = pathToFileURL(`${MY_MOD}/parts/thruster_a.rules`).href;

    it('offers the whole-mod fix beside the single-file one, naming both spellings', () => {
        const symbol = migrationSymbolOf('renamedAlias', 'CreatePartWhenDestroyed');
        const data: ValidationErrorData = { migration: { version: '0.23.0', apply: 'quickFix', symbol } };
        const action = migrateSymbolCodeAction(diagnosticWith(data), uri, data);
        expect(action?.title).toBe("Change every 'CreatePartWhenDestroyed' in this mod to 'UnderlyingPart'");
        expect(action?.command?.command).toBe(MIGRATE_SYMBOL_ACTION_COMMAND);
        expect(action?.command?.arguments?.[0]).toEqual({ symbol, uri } satisfies MigrateSymbolArgs);
        // The author asked about one line, so the whole-mod fix must never be what an "apply the
        // preferred fix" keystroke reaches.
        expect(action?.isPreferred).toBeUndefined();
    });

    it('words the offer without a replacement when the deprecation has none', () => {
        const symbol = migrationSymbolOf('deletedField', 'Flammable');
        const data: ValidationErrorData = { migration: { version: '0.30.0', apply: 'remove', symbol } };
        expect(migrateSymbolCodeAction(diagnosticWith(data), uri, data)?.title).toBe(
            "Migrate every 'Flammable' in this mod"
        );
    });

    it('declines a finding that has no mechanical fix', () => {
        const symbol = migrationSymbolOf('obsoleteField', 'ExplosiveDamageResistance');
        const data: ValidationErrorData = { migration: { version: '0.24.0', symbol } };
        expect(migrateSymbolCodeAction(diagnosticWith(data), uri, data)).toBeUndefined();
    });

    it('declines a finding that is not a migration at all, and an unknown symbol', () => {
        const plain: ValidationErrorData = { remove: { title: 'Remove', start: 0, end: 4 } };
        expect(migrateSymbolCodeAction(diagnosticWith(plain), uri, plain)).toBeUndefined();
        const stale: ValidationErrorData = { migration: { apply: 'remove', symbol: 'renamedAlias:gonefromregistry' } };
        expect(migrateSymbolCodeAction(diagnosticWith(stale), uri, stale)).toBeUndefined();
    });

    it('declines a file that is not inside a mod the tooling may rewrite', () => {
        const symbol = migrationSymbolOf('renamedAlias', 'CreatePartWhenDestroyed');
        const data: ValidationErrorData = { migration: { version: '0.23.0', apply: 'quickFix', symbol } };
        const loose = pathToFileURL(join(tmpdir(), 'not-a-mod', 'parts', 'loose.rules')).href;
        expect(migrateSymbolCodeAction(diagnosticWith(data), loose, data)).toBeUndefined();
    });
});

describe('which files a bulk fix may visit', () => {
    const symbol = migrationSymbolOf('renamedAlias', 'CreatePartWhenDestroyed');
    const roots = { [MY_MOD]: MY_MOD, [OTHER_MOD]: OTHER_MOD, [DATA_ROOT]: undefined, [WORKSHOP_MOD]: undefined };

    it('stays inside the mod the offer came from', async () => {
        const files = await narrowToSymbolScope(
            ALL_FILES,
            { symbol, scopeFsPath: `${MY_MOD}/parts/thruster_a.rules`, folderPaths: [FIXTURES] },
            token,
            fakeHost(ALL_FILES, roots)
        );
        expect(files).toEqual([
            `${MY_MOD}/parts/thruster_a.rules`,
            `${MY_MOD}/parts/thruster_b.rules`,
            `${MY_MOD}/parts/proxy.rules`,
        ]);
    });

    it('drops the files the mention index says cannot mention the old name', async () => {
        const candidates = [`${MY_MOD}/parts/thruster_b.rules`];
        const files = await narrowToSymbolScope(
            ALL_FILES,
            { symbol, scopeFsPath: `${MY_MOD}/parts/thruster_a.rules`, folderPaths: [FIXTURES] },
            token,
            fakeHost(candidates, roots)
        );
        // The file the offer came from is kept whatever the index says: its finding is right there in
        // front of the author, and its text can be an unsaved buffer the index has not read yet.
        expect(files).toEqual([`${MY_MOD}/parts/thruster_a.rules`, `${MY_MOD}/parts/thruster_b.rules`]);
    });

    it('visits the whole mod when the index cannot answer', async () => {
        const files = await narrowToSymbolScope(
            ALL_FILES,
            { symbol, scopeFsPath: `${MY_MOD}/parts/proxy.rules`, folderPaths: [FIXTURES] },
            token,
            fakeHost(undefined, roots)
        );
        expect(files).toHaveLength(3);
    });

    it('refuses outright when the offer came from a file that may not be rewritten', async () => {
        const files = await narrowToSymbolScope(
            ALL_FILES,
            { symbol, scopeFsPath: `${DATA_ROOT}/parts/vanilla_part.rules`, folderPaths: [FIXTURES] },
            token,
            fakeHost(ALL_FILES, roots)
        );
        expect(files).toEqual([]);
    });

    it('refuses a symbol no registry holds', async () => {
        const files = await narrowToSymbolScope(
            ALL_FILES,
            { symbol: 'renamedAlias:gonefromregistry', scopeFsPath: `${MY_MOD}/parts/proxy.rules`, folderPaths: [FIXTURES] },
            token,
            fakeHost(ALL_FILES, roots)
        );
        expect(files).toEqual([]);
    });
});

describe('the trees a bulk fix may rewrite, through the real gate', () => {
    let wasAllowed: boolean;

    beforeAll(async () => {
        // The gate answers against the install the workspace service was initialized with, so the
        // fixture mirrors Steam's own layout: the workshop folder is resolved off the data root.
        globalSettings.cosmoteerPath = DATA_ROOT;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(DATA_ROOT, noop);
        expect(service.dataRootPath?.replace(/\\/g, '/')).toBe(DATA_ROOT);
        wasAllowed = globalSettings.allowEditingVanillaFiles;
    });

    afterAll(() => {
        globalSettings.allowEditingVanillaFiles = wasAllowed;
    });

    const symbol = migrationSymbolOf('renamedAlias', 'CreatePartWhenDestroyed');
    const narrow = (scopeFsPath: string) =>
        narrowToSymbolScope(ALL_FILES, { symbol, scopeFsPath, folderPaths: [FIXTURES] }, token, {
            candidateFiles: async () => undefined,
            editableRootOf: (fsPath) => editableModRootOf(fsPath),
        });

    it('leaves the game data alone by default', async () => {
        globalSettings.allowEditingVanillaFiles = false;
        expect(await narrow(`${DATA_ROOT}/parts/vanilla_part.rules`)).toEqual([]);
        // And a sweep started in the mod never reaches into it either.
        const fromMod = await narrow(`${MY_MOD}/parts/thruster_a.rules`);
        expect(fromMod.some((file) => file.startsWith(DATA_ROOT))).toBe(false);
    });

    it('treats the data root as the project once the setting says the game data is being worked on', async () => {
        globalSettings.allowEditingVanillaFiles = true;
        expect(await narrow(`${DATA_ROOT}/parts/vanilla_part.rules`)).toEqual([
            `${DATA_ROOT}/parts/vanilla_part.rules`,
        ]);
    });

    it('never rewrites an installed workshop mod, whatever the setting says', async () => {
        for (const allowed of [false, true]) {
            globalSettings.allowEditingVanillaFiles = allowed;
            expect(await narrow(`${WORKSHOP_MOD}/parts/installed_part.rules`), `setting ${allowed}`).toEqual([]);
            const fromMod = await narrow(`${MY_MOD}/parts/thruster_a.rules`);
            expect(fromMod.some((file) => file.startsWith(WORKSHOP_MOD))).toBe(false);
        }
    });
});

describe('landing the rewrite', () => {
    let dir: string;

    afterEach(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    /** One rewritable file in a scratch directory, since applying writes to disk. */
    const change = (name: string, text: string, newText: string): MigrationChange => {
        const fsPath = join(dir, name).replace(/\\/g, '/');
        writeFileSync(fsPath, text, 'utf8');
        return {
            uri: pathToFileURL(fsPath).href,
            fsPath,
            text,
            edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText }],
        };
    };

    it('writes the files nobody has open and routes the open ones through the editor', async () => {
        dir = mkdtempSync(join(tmpdir(), 'migrate-symbol-'));
        const closed = change('closed.rules', 'Part\n', 'Base');
        const open = change('open.rules', 'Part\n', 'Base');
        const edited: string[] = [];
        const announced: string[] = [];
        const result = await applyMigrationChanges([closed, open], {
            openDocuments: () => [{ uri: open.uri }],
            applyEdit: async (changes) => {
                edited.push(...Object.keys(changes));
                return true;
            },
            filesChanged: (paths) => announced.push(...paths),
        });
        expect(result).toEqual({ files: 2, failed: [] });
        // A workspace edit over a file nobody opened would give it a dirty tab, and a whole-mod
        // rename would then leave hundreds of them behind.
        expect(readFileSync(closed.fsPath, 'utf8')).toBe('Base\n');
        expect(readFileSync(open.fsPath, 'utf8')).toBe('Part\n');
        expect(edited).toEqual([open.uri]);
        expect(announced.sort()).toEqual([closed.fsPath, open.fsPath].sort());
    });

    it('leaves a file alone whose text moved on while the sweep was running', async () => {
        dir = mkdtempSync(join(tmpdir(), 'migrate-symbol-'));
        const stale = change('stale.rules', 'Part\n', 'Base');
        writeFileSync(stale.fsPath, 'Something else entirely\n', 'utf8');
        const result = await applyMigrationChanges([stale], {
            openDocuments: () => [],
            applyEdit: async () => true,
            filesChanged: () => undefined,
        });
        // The edits were measured against text that is no longer there, so applying them could land
        // anywhere in the file.
        expect(result).toEqual({ files: 0, failed: [stale.fsPath] });
        expect(readFileSync(stale.fsPath, 'utf8')).toBe('Something else entirely\n');
    });

    it('does not bring back a file that was deleted while the sweep was running', async () => {
        dir = mkdtempSync(join(tmpdir(), 'migrate-symbol-'));
        const gone = change('gone.rules', 'Part\n', 'Base');
        rmSync(gone.fsPath);
        const result = await applyMigrationChanges([gone], {
            openDocuments: () => [],
            applyEdit: async () => true,
            filesChanged: () => undefined,
        });
        expect(result).toEqual({ files: 0, failed: [gone.fsPath] });
        expect(existsSync(gone.fsPath)).toBe(false);
    });

    it('counts an editor that turns the edit down as a file that did not change', async () => {
        dir = mkdtempSync(join(tmpdir(), 'migrate-symbol-'));
        const open = change('open.rules', 'Part\n', 'Base');
        const result = await applyMigrationChanges([open], {
            openDocuments: () => [{ uri: open.uri }],
            applyEdit: async () => false,
            filesChanged: () => undefined,
        });
        expect(result).toEqual({ files: 0, failed: [open.fsPath] });
        expect(readFileSync(open.fsPath, 'utf8')).toBe('Part\n');
    });
});

describe('the identities the deprecation registry hands out', () => {
    it('resolves every symbol back to the entry that produced it', () => {
        const symbols = allDeprecationSymbols();
        expect(symbols.length).toBeGreaterThan(0);
        expect(new Set(symbols).size).toBe(symbols.length);
        for (const symbol of symbols) {
            const entry = deprecationBySymbol(symbol);
            expect(entry, symbol).toBeDefined();
            // The canonical spelling has to fold to the key, or the mention-index pre-filter would
            // search for a name no file writes and the sweep would come back empty.
            expect(migrationSymbolOf(entry!.kind, entry!.name)).toBe(symbol);
        }
    });

    it('answers nothing for a symbol that names no registry', () => {
        expect(deprecationBySymbol('flammable')).toBeUndefined();
        expect(deprecationBySymbol('madeUpKind:flammable')).toBeUndefined();
        expect(deprecationBySymbol('deletedField:notafield')).toBeUndefined();
    });
});
