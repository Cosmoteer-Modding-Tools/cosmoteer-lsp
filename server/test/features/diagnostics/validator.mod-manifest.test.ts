import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { validateModManifest } from '../../../src/features/diagnostics/validator.mod-manifest';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

/** The findings for a manifest written at the fixture mod's own manifest path. */
const check = async (source: string, fsPath?: string) => {
    const uri = filePathToUri(fsPath ?? workspaceFile('mod.rules'));
    return validateModManifest(parseText(source, uri), token);
};

const messages = async (source: string, fsPath?: string) => (await check(source, fsPath)).map((e) => e.message);

describe('validateModManifest', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('accepts a manifest that declares what the game needs', async () => {
        expect(await messages('ID = mine.parts\nName = "Parts"\nVersion = 1.0\n')).toEqual([]);
    });

    it('reports a manifest with no ID', async () => {
        const found = await messages('Name = "Parts"\nVersion = 1.0\n');
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('ID');
    });

    it('reports an ID with no name on both sides of the dot', async () => {
        // ModInfo takes the first dot and throws unless a character stands on each side of it.
        for (const id of ['parts', '.parts', 'parts.']) {
            const found = await messages(`ID = ${id}\nName = "Parts"\n`);
            expect(found.some((message) => message.includes('author_name.mod_name'))).toBe(true);
        }
        expect(await messages('ID = a.b\nName = "Parts"\n')).toEqual([]);
    });

    it('binds a field name the way the game does, ignoring case', async () => {
        // OTGroupNode._childrenByName is InvariantCultureIgnoreCase, so this really does bind.
        expect(await messages('ID = a.b\nName = "x"\nModifiesGamePlay = true\n')).toEqual([]);
        expect(await messages('ID = a.b\nName = "x"\nStringsfolder = "strings"\n')).not.toContain(
            expect.stringContaining('not a manifest field')
        );
    });

    it('accepts the alias the game declares for ModifiesGameplay', async () => {
        expect(await messages('ID = a.b\nName = "x"\nModifiesMultiplayer = true\n')).toEqual([]);
    });

    it('accepts the two names the game reads outside its serialized members', async () => {
        // Actions is read by the constructor, UseThisFileIfNoVersionMatch while picking a manifest.
        const source = 'ID = a.b\nName = "x"\nUseThisFileIfNoVersionMatch = true\nActions\n[\n]\n';
        expect(await messages(source)).toEqual([]);
    });

    it('names the field a near-miss was meant to be', async () => {
        const found = await messages('ID = a.b\nName = "x"\nDiscription = "y"\n');
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('Description');
    });

    it('leaves a name that is nothing like a field alone', async () => {
        // A loader mod that ships a .dll keeps its own keys here, and the game ignores them quietly.
        expect(await messages('ID = a.b\nName = "x"\nDependencies = ["123"]\n')).toEqual([]);
    });

    it('leaves a constant the file reads back alone', async () => {
        // The game's own huge_crews manifest does exactly this.
        const source = 'ID = a.b\nName = "x"\nMAX_CREW = 100000\nActions\n[\n\t{\n\t\tValue = &~/MAX_CREW\n\t}\n]\n';
        expect(await messages(source)).toEqual([]);
    });

    it('leaves a bare named group alone', async () => {
        expect(await messages('ID = a.b\nName = "x"\nDeveloperMode\n{\n\tCareerEnemyParts = true\n}\n')).toEqual([]);
    });

    it('says nothing at all about a file that declares no manifest field', async () => {
        // A mod_*.rules holding data rather than metadata, or a file still being typed.
        expect(await messages('SomeData = 1\n')).toEqual([]);
    });

    it('reports a strings folder that is not on disk', async () => {
        const found = await messages('ID = a.b\nName = "x"\nStringsFolder = "no_such_folder"\n');
        expect(found).toHaveLength(1);
        expect(found[0]).toContain('no_such_folder');
    });
});

// The check is default-on, so its false-positive surface is every manifest a user already has. This
// replays it over the whole local corpus. It self-skips where the game and workshop are not installed.
const CORPUS_ROOTS = [
    'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Standard Mods',
    'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600',
];

const manifestsUnder = (dir: string, out: string[] = [], depth = 0): string[] => {
    if (depth > 6) return out;
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        const full = join(dir, name);
        let stats;
        try {
            stats = statSync(full);
        } catch {
            continue;
        }
        if (stats.isDirectory()) manifestsUnder(full, out, depth + 1);
        else if (/^mod(_.*)?\.rules$/i.test(name)) out.push(full);
    }
    return out;
};

const installed = CORPUS_ROOTS.filter((root) => existsSync(root));

describe.skipIf(installed.length === 0)('validateModManifest over every installed manifest', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('reports nothing on the real corpus', async () => {
        const files = installed.flatMap((root) => manifestsUnder(root));
        expect(files.length).toBeGreaterThan(0);
        const findings: string[] = [];
        for (const file of files) {
            const text = await readFile(file, 'utf-8').catch(() => null);
            if (text === null) continue;
            const errors = await validateModManifest(parseText(text, filePathToUri(file)), token);
            for (const error of errors) findings.push(`${file}: ${error.message}`);
        }
        expect(findings).toEqual([]);
        // The walk is cold on the first run and reads every declared folder of every installed mod.
    }, 120_000);
});
