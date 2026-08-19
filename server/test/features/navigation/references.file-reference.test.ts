import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationToken, Connection, Location, WorkDoneProgressReporter } from 'vscode-languageserver';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import { ReferenceIndex } from '../../../src/features/navigation/reference-index';
import { MentionIndex } from '../../../src/features/navigation/mention.index';

// The corpus names a part two ways, and find-all-references has to answer for both. The bare-id
// spelling (`EditorParentParts = ["test.armor"]`) carries the id in its text; the file-reference
// spelling (`PartsUnlocked = [&<./Data/parts/armor.rules>/Part/ID]`, which vanilla's own tech tree
// uses) carries no id at all. techs.rules below deliberately never writes `test.armor`, so it is
// invisible to a sweep keyed on the id and is only found because the search also sweeps on the
// declaring file's name.
const token = CancellationToken.None;

let dir: string;
let dataDir: string;
let folders: string[];
let armor: AbstractNodeDocument;

/** The cursor position of the `ID = test.armor` value in armor.rules. */
const armorIdPosition = async () => {
    const source = await readFile(join(dataDir, 'parts', 'armor.rules'), 'utf8');
    const at = source.indexOf('ID = test.armor');
    const before = source.slice(0, at);
    return {
        line: before.split('\n').length - 1,
        character: at - (before.lastIndexOf('\n') + 1) + 'ID = '.length + 1,
    };
};

/** The bare file names of a result set, so an expectation can name a file without its path. */
const files = (locations: Location[]): string[] =>
    locations.map((location) => location.uri.replace(/\\/g, '/').split('/').pop() ?? '');

describe('find-all-references over the file-reference spelling of an id', () => {
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'cosmo-fileref-'));
        dataDir = join(dir, 'Data');
        await mkdir(join(dataDir, 'parts'), { recursive: true });
        await mkdir(join(dataDir, 'modes'), { recursive: true });
        await writeFile(
            join(dataDir, 'parts', 'armor.rules'),
            'Part\n{\n\tID = test.armor\n\tNameKey = "Parts/Armor"\n\tMaxHealth = 100\n}\n'
        );
        // The bare-id spelling: this file mentions the id and nothing else.
        await writeFile(
            join(dataDir, 'parts', 'wedge.rules'),
            'Part\n{\n\tID = test.wedge\n\tEditorParentParts = ["test.armor"]\n}\n'
        );
        // The file-reference spelling, and not one occurrence of the part id anywhere in the file.
        // Two techs unlock the part, so a search that collapses the sites returns the wrong count.
        await writeFile(
            join(dataDir, 'modes', 'techs.rules'),
            'Techs\n[\n\t{\n\t\tID = tech.plating\n\t\tPartsUnlocked = [&<./Data/parts/armor.rules>/Part/ID]\n\t}\n' +
                '\t{\n\t\tID = tech.plating_advanced\n\t\tPartsUnlocked = [&<./Data/parts/armor.rules>/Part/ID]\n\t}\n]\n'
        );
        // Caught by both sweeps: it writes the id AND references the file. Its file reference points
        // at another member, so the id is named exactly once here.
        await writeFile(
            join(dataDir, 'parts', 'hybrid.rules'),
            'Part\n{\n\tID = test.hybrid\n\tEditorParentParts = ["test.armor"]\n' +
                '\tNameKey = &<./Data/parts/armor.rules>/Part/NameKey\n}\n'
        );
        folders = [dataDir];

        globalSettings.cosmoteerPath = dataDir;
        const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        await service.initialize(dataDir, noop);
        MentionIndex.instance.reset();
        armor = await parseFilePath(join(dataDir, 'parts', 'armor.rules'));
    }, 120_000);

    afterAll(async () => {
        MentionIndex.instance.reset();
        await rm(dir, { recursive: true, force: true });
    });

    it('the fixture premise holds: the tech file never writes the part id', async () => {
        const techs = await readFile(join(dataDir, 'modes', 'techs.rules'), 'utf8');
        expect(techs).not.toContain('test.armor');
        expect(techs).toContain('armor.rules');
    });

    it('finds both spellings from the declaration, the file-reference one included', async () => {
        const refs = await ReferenceIndex.instance.findReferences(armor, await armorIdPosition(), false, folders, token);
        const found = files(refs).sort();
        expect(found).toEqual(['hybrid.rules', 'techs.rules', 'techs.rules', 'wedge.rules']);
    });

    it('returns every file-reference site, not one per file', async () => {
        const refs = await ReferenceIndex.instance.findReferences(armor, await armorIdPosition(), false, folders, token);
        const lines = refs
            .filter((location) => location.uri.endsWith('techs.rules'))
            .map((location) => location.range.start.line)
            .sort((a, b) => a - b);
        expect(lines).toEqual([4, 8]);
    });

    it('names a file caught by both sweeps once, and only for the reference that lands on the id', async () => {
        const refs = await ReferenceIndex.instance.findReferences(armor, await armorIdPosition(), false, folders, token);
        // hybrid.rules writes the id once and references the file once, but that reference points at
        // NameKey, so the file contributes exactly the one bare-id site.
        expect(files(refs).filter((name) => name === 'hybrid.rules').length).toBe(1);
    });

    it('leaves the declaration out of the usages and adds it back on request', async () => {
        const position = await armorIdPosition();
        const without = await ReferenceIndex.instance.findReferences(armor, position, false, folders, token);
        expect(files(without)).not.toContain('armor.rules');

        const withDeclaration = await ReferenceIndex.instance.findReferences(armor, position, true, folders, token);
        expect(withDeclaration.length).toBe(without.length + 1);
        expect(files(withDeclaration).filter((name) => name === 'armor.rules').length).toBe(1);
    });
});
