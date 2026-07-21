import { afterAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateManifestVersion } from '../../../src/features/diagnostics/validator.manifest-version';

// A `mod_*.rules` without `CompatibleGameVersions` gets no selection priority in the game's
// manifest scan (GetModInfoPath, verified in Cosmoteer.dll), so beside another manifest it is
// silently dead. The check reads the real filesystem for sibling manifests, so each case builds a
// throwaway mod folder on disk.
const token = CancellationToken.None;
const ROOT = join(tmpdir(), `manifest-version-test-${process.pid}`);
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let caseId = 0;
const modFolder = (files: Record<string, string>): string => {
    const dir = join(ROOT, `case${caseId++}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        const path = join(dir, name);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, content);
    }
    return dir;
};

const validate = (dir: string, name: string, content: string) =>
    validateManifestVersion(parser(lexer(content), pathToFileURL(join(dir, name)).href).value, token);

const OLD_MANIFEST = 'ID = test.mod\nName = "Old"\n';
const VERSIONED = 'ID = test.mod\nName = "New"\nCompatibleGameVersions = ["0.30.4c"]\n';

describe('manifest version selectability', () => {
    it('flags a mod_*.rules without CompatibleGameVersions beside another manifest', async () => {
        const dir = modFolder({ 'mod.rules': VERSIONED, 'mod_old.rules': OLD_MANIFEST });
        const errors = await validate(dir, 'mod_old.rules', OLD_MANIFEST);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('never selects');
        expect(errors[0].severity).toBe('warning');
    });

    it('stays silent when the file carries CompatibleGameVersions', async () => {
        const dir = modFolder({ 'mod.rules': VERSIONED, 'mod_old.rules': VERSIONED });
        expect(await validate(dir, 'mod_old.rules', VERSIONED)).toEqual([]);
    });

    it('stays silent when the file is the mod\'s only manifest', async () => {
        // A single-manifest mod is used unconditionally (GetModInfoPath returns early), so a lone
        // mod_*.rules without the field is fine.
        const dir = modFolder({ 'mod_only.rules': OLD_MANIFEST });
        expect(await validate(dir, 'mod_only.rules', OLD_MANIFEST)).toEqual([]);
    });

    it('never flags the plain mod.rules', async () => {
        // A mod.rules without the field keeps fallback priority 0 and stays selectable.
        const dir = modFolder({ 'mod.rules': OLD_MANIFEST, 'mod_new.rules': VERSIONED });
        expect(await validate(dir, 'mod.rules', OLD_MANIFEST)).toEqual([]);
    });

    it('finds a root manifest above a version sub-folder', async () => {
        const dir = modFolder({ 'mod.rules': VERSIONED, 'versions/mod_old.rules': OLD_MANIFEST });
        const errors = await validate(join(dir, 'versions'), 'mod_old.rules', OLD_MANIFEST);
        expect(errors).toHaveLength(1);
    });
});
