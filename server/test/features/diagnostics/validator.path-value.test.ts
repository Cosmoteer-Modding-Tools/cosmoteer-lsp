import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { globalSettings } from '../../../src/settings';
import { documentRootClass } from '../../../src/document/schema/document-root';
import { schema } from '../../../src/document/schema/schema';
import { ValueType } from '../../../src/document/schema/schema.types';
import { PATH_FIELD_KINDS, validatePathValues } from '../../../src/features/diagnostics/validator.path-value';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const token = CancellationToken.None;

// The check answers from disk, so the fixtures are real files in a temp tree. A music track and a
// name generator root from their folder name alone, which gives both a file-shaped and a
// folder-shaped field to write without standing up a whole game tree.
let root = '';

/** The findings for a source written at `relative` inside the temp tree. */
const check = async (source: string, relative: string) =>
    validatePathValues(parseText(source, filePathToUri(join(root, relative))), token);

const messages = async (source: string, relative: string) => (await check(source, relative)).map((e) => e.message);

describe('validatePathValues', () => {
    beforeAll(async () => {
        await initWorkspace();
        // `./Data/…` is read from the game folder, so the fixture workspace stands in for the install.
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
        root = mkdtempSync(join(tmpdir(), 'cosmoteer-paths-'));
        mkdirSync(join(root, 'music', 'strings'), { recursive: true });
        mkdirSync(join(root, 'name_generators'), { recursive: true });
        mkdirSync(join(root, 'builtin_ships'), { recursive: true });
        mkdirSync(join(root, 'kinds'), { recursive: true });
        writeFileSync(join(root, 'kinds', 'alpha'), '', 'utf8');
        writeFileSync(join(root, 'music', 'Cluster1_Intro.music'), '', 'utf8');
        writeFileSync(join(root, 'music', 'notes.rules'), '', 'utf8');
        writeFileSync(join(root, 'name_generators', 'latin.markov'), '', 'utf8');
        writeFileSync(join(root, 'name_generators', 'real.gif'), '', 'utf8');
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('reports a music track that is not on disk', async () => {
        const found = await check('Type = File\nFile = "missing.music"\n', 'music/track.rules');
        expect(found).toHaveLength(1);
        expect(found[0].message).toBe('The file "missing.music" does not exist');
        expect(found[0].severity).toBe('warning');
        expect(found[0].additionalInfo).toContain('relative to the folder this file is in');
    });

    it('says nothing about a track that is on disk, whatever its letter case', async () => {
        // The game reads through a filesystem that ignores case, and mods rely on that.
        expect(await messages('Type = File\nFile = "Cluster1_Intro.music"\n', 'music/track.rules')).toEqual([]);
        expect(await messages('Type = File\nFile = "cluster1_intro.MUSIC"\n', 'music/track.rules')).toEqual([]);
    });

    it('names a missing folder as a folder', async () => {
        const source = (value: string) => `EffectBuckets\n[\n]\nBuiltInShipsFolder = "${value}"\n`;
        expect(await messages(source('nope'), 'cosmoteer.rules')).toEqual(['The folder "nope" does not exist']);
        expect(await messages(source('builtin_ships'), 'cosmoteer.rules')).toEqual([]);
    });

    it('reads a list element under both spellings of a list', async () => {
        // A list element carries no `Key = ` of its own, so the field name comes from the list.
        const assigned = 'Layer\n{\n\tType = Decals\n\tDecalFiles = ["nope.gif"]\n}\n';
        const named = 'Layer\n{\n\tType = Decals\n\tDecalFiles\n\t[\n\t\tnope.gif\n\t]\n}\n';
        const expected = ['The file "nope.gif" does not exist'];
        expect(await messages(assigned, 'name_generators/layers.rules')).toEqual(expected);
        expect(await messages(named, 'name_generators/layers.rules')).toEqual(expected);
        expect(await messages(assigned.replace('nope.gif', 'real.gif'), 'name_generators/layers.rules')).toEqual([]);
    });

    it('offers the closest existing name as a quick fix', async () => {
        const found = await check('Type = File\nFile = "Cluster1_Inrto.music"\n', 'music/track.rules');
        expect(found).toHaveLength(1);
        expect(found[0].data?.quickFix?.newText).toBe('Cluster1_Intro.music');
        // A mistyped extension is correctable too, since the whole folder is fallen back on when no
        // entry carries the written one.
        const extension = await check('Type = File\nFile = "Cluster1_Intro.mus"\n', 'music/track.rules');
        expect(extension[0].data?.quickFix?.newText).toBe('Cluster1_Intro.music');
    });

    it('only offers an entry of the expected kind', async () => {
        // The one near name in this folder is a file, and a folder field cannot be answered with one.
        const source = 'EffectBuckets\n[\n]\nBuiltInShipsFolder = "alphb"\n';
        const found = await check(source, 'kinds/cosmoteer.rules');
        expect(found).toHaveLength(1);
        expect(found[0].data).toBeUndefined();
    });

    it('resolves a path written from the game folder', async () => {
        expect(await messages('Type = File\nFile = "./Data/effects/missing.music"\n', 'music/track.rules')).toEqual([
            'The file "./Data/effects/missing.music" does not exist',
        ]);
        expect(await messages('Type = File\nFile = "./Data/a.rules"\n', 'music/track.rules')).toEqual([]);
    });

    it('leaves a same-named field of another class alone', async () => {
        // `Ship` on a ship spawner names a built-in ship by id, not a blueprint on disk, and `File`
        // decides nothing at all in a file whose class does not resolve. The spawner's class is
        // asserted, so that case cannot pass merely because the file failed to root.
        const spawner = parseText(
            'Type = Ships\nShip = "no_such_ship"\n',
            filePathToUri(join(root, 'sectors/s.rules'))
        );
        expect(documentRootClass(spawner)).toBe('Cosmoteer.Generators.Simulation.ShipSpawner');
        expect(await validatePathValues(spawner, token)).toEqual([]);
        expect(await messages('File = "missing.music"\n', 'notes/plain.rules')).toEqual([]);
    });

    it('leaves a value the game does not read as a written path alone', async () => {
        // A reference is whatever it resolves to, and an empty value names nothing.
        expect(await messages('Type = File\nFile = &~/SOME_PATH\n', 'music/track.rules')).toEqual([]);
        expect(await messages('Type = File\nFile = ""\n', 'music/track.rules')).toEqual([]);
    });

    it('leaves the path shapes the game reads elsewhere alone', async () => {
        // A rooted path and a `./` path are both read from the game's working directory, and a
        // backslash means one thing on Windows and another everywhere else.
        expect(await messages('Type = File\nFile = "/missing.music"\n', 'music/track.rules')).toEqual([]);
        expect(await messages('Type = File\nFile = "C:/missing.music"\n', 'music/track.rules')).toEqual([]);
        expect(await messages('Type = File\nFile = "./missing.music"\n', 'music/track.rules')).toEqual([]);
        expect(await messages('Type = File\nFile = "sub\\\\missing.music"\n', 'music/track.rules')).toEqual([]);
        // Unquoted, the game reads the whole line as one value, which is a quoting problem rather
        // than a missing file.
        expect(await messages('Type = File\nFile = my track.music\n', 'music/track.rules')).toEqual([]);
    });

    it('says nothing about a value the asset check already covers', async () => {
        // The parser types a value carrying a known asset extension as an asset, which the value
        // validator resolves. Reporting it here would report the same file twice.
        expect(await messages('Type = File\nFile = "missing.png"\n', 'music/track.rules')).toEqual([]);
    });

    it('exempts a strings file', async () => {
        // A language file holds display text, so a line whose key happens to name a path is prose.
        expect(await messages('Type = File\nFile = "missing.music"\n', 'music/strings/en.rules')).toEqual([]);
    });

    it('leaves a manifest to the manifest check', async () => {
        expect(await messages('Type = File\nFile = "missing.music"\n', 'music/mod.rules')).toEqual([]);
    });

    it('knows every path field the schema declares', async () => {
        // The table decides the wording of the finding, and a field it does not name goes unchecked,
        // so a path field a future game version adds has to be judged here rather than fall silent.
        const isPath = (valueType: ValueType | undefined): boolean =>
            valueType?.kind === 'string' && valueType.semantic === 'path';
        const declared = new Set<string>();
        for (const type of Object.values(schema.types)) {
            for (const field of type.fields) {
                const valueType = field.valueType;
                const element =
                    valueType.kind === 'list' || valueType.kind === 'range' || valueType.kind === 'interpolated'
                        ? valueType.element
                        : undefined;
                const scalarForm = valueType.kind === 'group' ? schema.types[valueType.ref]?.valueForm : undefined;
                if (isPath(valueType) || isPath(element) || isPath(scalarForm)) declared.add(field.name.toLowerCase());
            }
        }
        expect([...declared].sort()).toEqual([...PATH_FIELD_KINDS.keys()].sort());
    });
});
