import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { referenceRepairEdit } from '../../../src/features/refactor/rename-file-references';
import { globalSettings } from '../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';

const token = CancellationToken.None;

let root = '';
let modRoot = '';
let dataRoot = '';
let folders: string[] = [];
let wasAllowed = false;

/** The file the edits of one move land in, keyed by file name, with the edits already applied. */
const repairedFiles = async (oldPath: string, newPath: string): Promise<Record<string, string>> => {
    const edit = await referenceRepairEdit([{ oldPath, newPath }], folders, token);
    const out: Record<string, string> = {};
    for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
        const path = fileURLToPath(uri);
        const document = TextDocument.create(uri, 'rules', 0, readFileSync(path, 'utf8'));
        out[path.split(/[\\/]/).pop()!] = TextDocument.applyEdits(document, edits);
    }
    return out;
};

/** Every file path one move answers with, which is what the editor has to be able to read. */
const repairedPaths = async (oldPath: string, newPath: string): Promise<string[]> => {
    const edit = await referenceRepairEdit([{ oldPath, newPath }], folders, token);
    return Object.keys(edit?.changes ?? {}).map((uri) => fileURLToPath(uri));
};

/** One line of a file as it stands on disk, for a test that asserts nothing was written to it. */
const lineOf = (path: string, index: number): string => readFileSync(path, 'utf8').split(/\r?\n/)[index];

describe('repairing references when a file moves', () => {
    beforeAll(async () => {
        // The capital in the folder name is the point: a path lowercased anywhere on the way to the
        // filesystem names nothing where names are case-sensitive.
        root = mkdtempSync(join(tmpdir(), 'cosmoteer-rename-'));
        modRoot = join(root, 'Mod');
        mkdirSync(join(modRoot, 'parts'), { recursive: true });
        mkdirSync(join(modRoot, 'shared'), { recursive: true });
        writeFileSync(join(modRoot, 'shared', 'base.rules'), 'Base\n{\n\tA = 1\n}\n');
        writeFileSync(join(modRoot, 'parts', 'gun.rules'), 'Part : &<../shared/base.rules>/Base\n{\n\tB = 2\n}\n');
        writeFileSync(join(modRoot, 'reader.rules'), 'Thing\n{\n\tValue = &<shared/base.rules>/Base/A\n}\n');
        // Every form the repair must leave alone, in a file that also writes one reference it must
        // rewrite, so the file is swept for the rename and its other lines are still untouched.
        writeFileSync(
            join(modRoot, 'mixed.rules'),
            [
                'Thing',
                '{',
                '\tMoving = &<shared/base.rules>/Base/A',
                '\tBackslash = &<parts\\gun.rules>/Part',
                '\tCurrent = &<./parts/gun.rules>/Part',
                '\tRooted = </Data/ships/terran/base_part.rules>',
                '\tMarkup = / Alastair Hebson</fame_color></s20></b>',
                '\tQuoted = "&<shared/base.rules>/Base/A"',
                '\tPadded = &< shared/base.rules >/Base/A',
                '\tTail = ~/Root<shared/base.rules>',
                '}',
                '',
            ].join('\n')
        );
        // The same markup a credits file writes, in a file that is itself moving, where every path
        // is re-expressed against the new folder and a mistaken reference would be rewritten.
        writeFileSync(
            join(modRoot, 'parts', 'credits_style.rules'),
            [
                'Thing',
                '{',
                '\tBase = &<../shared/base.rules>/Base',
                '\tCredits = / Alastair Hebson</fame_color></s20></b>',
                '\tRooted = </Data/ships/terran/base_part.rules>',
                '}',
                '',
            ].join('\n')
        );

        // A file named with a capital, and the two spellings the corpus reaches it by: the name as
        // the filesystem writes it, and another case the filesystem resolves just the same.
        writeFileSync(join(modRoot, 'parts', 'Laser_Shot.rules'), 'Shot\n{\n\tDamage = 1\n}\n');
        writeFileSync(join(modRoot, 'parts', 'gun_a.rules'), 'Gun\n{\n\tShot = &<Laser_Shot.rules>/Shot\n}\n');
        writeFileSync(join(modRoot, 'parts', 'gun_b.rules'), 'Gun\n{\n\tShot = &<LASER_SHOT.rules>/Shot\n}\n');

        // A part with the asset forms a move has to tell apart: two paths naming a file that is
        // really there, one naming nothing, one read from the install root, and one sentence that
        // is typed as a sprite only because it mentions the extension.
        mkdirSync(join(modRoot, 'parts', 'sounds'), { recursive: true });
        writeFileSync(join(modRoot, 'parts', 'icon.png'), '');
        writeFileSync(join(modRoot, 'parts', 'sounds', 'fire.wav'), '');
        writeFileSync(join(modRoot, 'parts', 'extra.txt'), 'Extra\n{\n\tZ = 1\n}\n');
        writeFileSync(
            join(modRoot, 'parts', 'blaster.rules'),
            [
                'Blaster : &<../shared/base.rules>/Base',
                '{',
                '\tFragment = &<extra.txt>/Extra/Z',
                '\tIcon = "icon.png"',
                '\tFireSound = sounds/fire.wav',
                '\tGone = "nowhere.png"',
                '\tShared = "./Data/ships/terran/icon.png"',
                '\tHint = "PNG image files (*.png) are read here"',
                '\tDetour = "sounds/../sounds/fire.wav"',
                '}',
                '',
            ].join('\n')
        );

        // A game install of its own, laid out the Steam way, holding a file that names the mod file
        // about to move. Nothing of the real install is read or written.
        dataRoot = join(root, 'steamapps', 'common', 'Cosmoteer', 'Data');
        mkdirSync(join(dataRoot, 'ships'), { recursive: true });
        const vanillaFile = join(dataRoot, 'ships', 'vanilla_reader.rules');
        const toBase = relative(dirname(vanillaFile), join(modRoot, 'shared', 'base.rules')).replace(/\\/g, '/');
        writeFileSync(vanillaFile, `Thing\n{\n\tValue = &<${toBase}>/Base/A\n}\n`);

        const noop: WorkDoneProgressReporter = {
            begin: () => undefined,
            report: () => undefined,
            done: () => undefined,
        };
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection({
            languages: { diagnostics: { refresh: () => undefined } },
            window: { showWarningMessage: () => undefined },
        } as unknown as Connection);
        globalSettings.cosmoteerPath = dataRoot;
        await service.initialize(dataRoot, noop);
        wasAllowed = globalSettings.allowEditingVanillaFiles;
        globalSettings.allowEditingVanillaFiles = false;

        // What the server sweeps: the opened folders plus the game's own install, which is searched
        // for references and never written.
        folders = [pathToFileURL(modRoot).href, pathToFileURL(dataRoot).href];
    });

    afterAll(() => {
        globalSettings.allowEditingVanillaFiles = wasAllowed;
        rmSync(root, { recursive: true, force: true });
    });

    it('rewrites a reference to the file that moved', async () => {
        const repaired = await repairedFiles(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        expect(repaired['reader.rules']).toContain('Value = &<lib/base.rules>/Base/A');
    });

    it('rewrites a reference written with a folder step of its own', async () => {
        const repaired = await repairedFiles(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        expect(repaired['gun.rules']).toContain('Part : &<../lib/base.rules>/Base');
    });

    it('rewrites what the moved file itself points at', async () => {
        // `gun.rules` reaches its base with `../shared`, which says something else from a new folder.
        const repaired = await repairedFiles(join(modRoot, 'parts', 'gun.rules'), join(modRoot, 'gun.rules'));
        expect(repaired['gun.rules']).toContain('Part : &<shared/base.rules>/Base');
    });

    it('addresses the moved file its own edits at the path it still sits at', async () => {
        const oldPath = join(modRoot, 'parts', 'gun.rules');
        const paths = await repairedPaths(oldPath, join(modRoot, 'gun.rules'));
        // The editor applies a rename participant's edit before it performs the rename, and one
        // edit naming a file that is not there yet loses the whole answer, this file's included.
        expect(paths).toContain(oldPath);
        expect(paths).not.toContain(join(modRoot, 'gun.rules'));
    });

    it('rewrites a reference to a file whose name carries a capital', async () => {
        const repaired = await repairedFiles(
            join(modRoot, 'parts', 'Laser_Shot.rules'),
            join(modRoot, 'parts', 'shots', 'Laser_Shot.rules')
        );
        expect(repaired['gun_a.rules']).toContain('Shot = &<shots/Laser_Shot.rules>/Shot');
    });

    it('rewrites a reference that spells the file name in another case than the file does', async () => {
        const repaired = await repairedFiles(
            join(modRoot, 'parts', 'Laser_Shot.rules'),
            join(modRoot, 'parts', 'shots', 'Laser_Shot.rules')
        );
        // The rewrite spells the file the way the filesystem does, which is what a case-sensitive
        // filesystem needs and what the author would have written by hand.
        expect(repaired['gun_b.rules']).toContain('Shot = &<shots/Laser_Shot.rules>/Shot');
    });

    it('rebases the sprites and sounds of a file that changes folder', async () => {
        const repaired = await repairedFiles(
            join(modRoot, 'parts', 'blaster.rules'),
            join(modRoot, 'parts', 'weapons', 'blaster.rules')
        );
        const lines = repaired['blaster.rules'].split('\n');
        expect(lines[0]).toBe('Blaster : &<../../shared/base.rules>/Base');
        expect(lines[3]).toBe('\tIcon = "../icon.png"');
        expect(lines[4]).toBe('\tFireSound = ../sounds/fire.wav');
    });

    it('rebases a reference to a txt fragment of a file that changes folder', async () => {
        const repaired = await repairedFiles(
            join(modRoot, 'parts', 'blaster.rules'),
            join(modRoot, 'parts', 'weapons', 'blaster.rules')
        );
        // The game's loader reads a referenced `.txt` through the same parser as a `.rules`, so the
        // path is measured from the declaring folder and moves with the file writing it.
        expect(repaired['blaster.rules'].split('\n')[2]).toBe('\tFragment = &<../extra.txt>/Extra/Z');
    });

    it('leaves every asset value it cannot prove names a file alone', async () => {
        const repaired = await repairedFiles(
            join(modRoot, 'parts', 'blaster.rules'),
            join(modRoot, 'parts', 'weapons', 'blaster.rules')
        );
        const lines = repaired['blaster.rules'].split('\n');
        expect(lines[5]).toBe('\tGone = "nowhere.png"');
        expect(lines[6]).toBe('\tShared = "./Data/ships/terran/icon.png"');
        expect(lines[7]).toBe('\tHint = "PNG image files (*.png) are read here"');
    });

    it('leaves the assets of a file that stays where it is alone', async () => {
        const repaired = await repairedFiles(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        const lines = (repaired['blaster.rules'] ?? '').split('\n');
        expect(lines[0]).toBe('Blaster : &<../lib/base.rules>/Base');
        expect(lines[2]).toBe('\tFragment = &<extra.txt>/Extra/Z');
        expect(lines[3]).toBe('\tIcon = "icon.png"');
        expect(lines[4]).toBe('\tFireSound = sounds/fire.wav');
        // A path the author wrote the long way round still names the same file from the same
        // folder, so a rename of somebody else is no occasion to tidy it.
        expect(lines[8]).toBe('\tDetour = "sounds/../sounds/fire.wav"');
    });

    it('answers nothing for a file nothing points at', async () => {
        const repaired = await repairedFiles(join(modRoot, 'reader.rules'), join(modRoot, 'moved.rules'));
        expect(repaired).toEqual({});
    });

    it('answers nothing when the txt fragment itself is renamed', async () => {
        // The editor asks nothing about a `.txt` rename, so a repair computed for one would be
        // answered into the void while the sweep needle is built from a `.rules` name.
        const edit = await referenceRepairEdit(
            [{ oldPath: join(modRoot, 'parts', 'extra.txt'), newPath: join(modRoot, 'parts', 'extra2.txt') }],
            folders,
            token
        );
        expect(edit).toBeUndefined();
    });

    it('answers nothing for a file that is not a rules file', async () => {
        const edit = await referenceRepairEdit(
            [{ oldPath: join(modRoot, 'a.png'), newPath: join(modRoot, 'b.png') }],
            folders,
            token
        );
        expect(edit).toBeUndefined();
    });

    it('leaves a reference that names no moved file exactly as the author wrote it', async () => {
        const repaired = await repairedFiles(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        const lines = repaired['mixed.rules'].split('\n');
        expect(lines[2]).toBe('\tMoving = &<lib/base.rules>/Base/A');
        expect(lines[3]).toBe('\tBackslash = &<parts\\gun.rules>/Part');
        expect(lines[4]).toBe('\tCurrent = &<./parts/gun.rules>/Part');
    });

    it('leaves a rooted path alone, in a file that is moving as well as in one that is not', async () => {
        const staying = await repairedFiles(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        expect(staying['mixed.rules'].split('\n')[5]).toBe('\tRooted = </Data/ships/terran/base_part.rules>');
        const moving = await repairedFiles(
            join(modRoot, 'parts', 'credits_style.rules'),
            join(modRoot, 'deep', 'nested', 'credits_style.rules')
        );
        expect(moving['credits_style.rules'].split('\n')[2]).toBe('\tBase = &<../../shared/base.rules>/Base');
        expect(moving['credits_style.rules'].split('\n')[4]).toBe('\tRooted = </Data/ships/terran/base_part.rules>');
    });

    it('never rewrites text markup into a path', async () => {
        const staying = await repairedFiles(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        expect(staying['mixed.rules'].split('\n')[6]).toBe('\tMarkup = / Alastair Hebson</fame_color></s20></b>');
        // A bracket run further along a value is text, whatever it spells, so even one naming the
        // moved file is left alone.
        expect(staying['mixed.rules'].split('\n')[9]).toBe('\tTail = ~/Root<shared/base.rules>');
        const moving = await repairedFiles(
            join(modRoot, 'parts', 'credits_style.rules'),
            join(modRoot, 'deep', 'nested', 'credits_style.rules')
        );
        expect(moving['credits_style.rules'].split('\n')[3]).toBe(
            '\tCredits = / Alastair Hebson</fame_color></s20></b>'
        );
    });

    it('replaces exactly the characters it covers, quotes and spacing included', async () => {
        const repaired = await repairedFiles(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        const lines = repaired['mixed.rules'].split('\n');
        expect(lines[7]).toBe('\tQuoted = "&<lib/base.rules>/Base/A"');
        expect(lines[8]).toBe('\tPadded = &<lib/base.rules>/Base/A');
        expect(lines[10]).toBe('}');
    });

    it('keeps its edits out of the game install while it repairs the mod', async () => {
        const vanillaFile = join(dataRoot, 'ships', 'vanilla_reader.rules');
        const before = lineOf(vanillaFile, 2);
        const repaired = await repairedFiles(join(modRoot, 'shared', 'base.rules'), join(modRoot, 'lib', 'base.rules'));
        expect(Object.keys(repaired)).not.toContain('vanilla_reader.rules');
        expect(lineOf(vanillaFile, 2)).toBe(before);
        expect(repaired['reader.rules']).toContain('Value = &<lib/base.rules>/Base/A');
    });

    it('writes nothing into the game install for a file being moved out of it', async () => {
        const vanillaFile = join(dataRoot, 'ships', 'vanilla_reader.rules');
        const before = lineOf(vanillaFile, 2);
        // The edit would land at the old path, which is the install, so the rebase is refused even
        // though the file is on its way into the mod.
        const paths = await repairedPaths(vanillaFile, join(modRoot, 'vanilla_reader.rules'));
        expect(paths).not.toContain(vanillaFile);
        expect(lineOf(vanillaFile, 2)).toBe(before);
    });

    it('repairs the game install too once the setting says the game data is being worked on', async () => {
        globalSettings.allowEditingVanillaFiles = true;
        try {
            const repaired = await repairedFiles(
                join(modRoot, 'shared', 'base.rules'),
                join(modRoot, 'lib', 'base.rules')
            );
            expect(repaired['vanilla_reader.rules']).toContain('/lib/base.rules>/Base/A');
        } finally {
            globalSettings.allowEditingVanillaFiles = false;
        }
    });
});
