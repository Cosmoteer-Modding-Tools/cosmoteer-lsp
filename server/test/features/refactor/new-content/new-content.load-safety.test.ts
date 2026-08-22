import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { isGroupNode } from '../../../../src/core/ast/ast';
import { schema } from '../../../../src/document/schema/schema';
import {
    contentFilePathOf,
    emitContent,
} from '../../../../src/features/refactor/new-content/content-templates';
import { ContentKind } from '../../../../src/features/refactor/new-content/new-content.types';
import { flattenGroup } from '../../../../src/semantics/effective-group';
import { globalSettings } from '../../../../src/settings';
import { parseText } from '../../../../src/utils/ast.utils';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';

// The one proof available in the repo that a generated file would actually load. The game drops a
// whole part file when a field it throws over is missing, and the required-field check deliberately
// skips `PartRules` as too inheritance-heavy to judge, so nothing we ship would catch a template
// that forgot one. Folding the template against the real install answers it directly: every field
// the engine throws over has to be there, from the template or from the base it inherits.
//
// Self-skipped without the game, so it never runs in CI. The templates themselves still need one
// manual confirmation in game before release, which no test here can stand in for.
const DATA_DIR = (process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data')
    .replace(/\\/g, '/');
const HAVE = existsSync(join(DATA_DIR, 'cosmoteer.rules'));
const PART_RULES = 'Cosmoteer.Ships.Parts.PartRules';
const token = CancellationToken.None;

let MOD_DIR = '';

/** Every field of a class the engine throws over when the deserialized data does not carry it. */
const mandatoryFieldsOf = (cls: string): string[] =>
    Object.values(schema.types[cls]?.fields ?? {})
        .filter((field) => field.optional === false && field.absentThrows)
        .map((field) => field.name);

/** The template written into the scratch mod, at the path the command would create it at. */
const writeTemplate = (kind: ContentKind, name: string, id: string): string => {
    const fsPath = contentFilePathOf(MOD_DIR, kind, name);
    mkdirSync(dirname(fsPath), { recursive: true });
    writeFileSync(fsPath, emitContent(kind, name, id).text, { encoding: 'utf-8' });
    return fsPath;
};

beforeAll(async () => {
    if (!HAVE) return;
    MOD_DIR = `${mkdtempSync(join(tmpdir(), 'newcontent-load-')).replace(/\\/g, '/')}/mod`;
    mkdirSync(MOD_DIR, { recursive: true });
    writeFileSync(join(MOD_DIR, 'mod.rules'), 'ID = test.loadsafety\nName = "Load Safety"\n', { encoding: 'utf-8' });
    globalSettings.cosmoteerPath = DATA_DIR;
    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    await service.initialize(DATA_DIR, noop);
});

afterAll(() => {
    if (MOD_DIR) rmSync(dirname(MOD_DIR), { recursive: true, force: true });
});

describe.skipIf(!HAVE)('whether a created file would load in the real game', () => {
    it('reaches the base it names, from a mod at any depth', async () => {
        const fsPath = writeTemplate('part', 'load_probe', 'test.load_probe');
        const document = parseText(emitContent('part', 'load_probe', 'test.load_probe').text, pathToFileURL(fsPath).href);
        const group = document.elements.find(isGroupNode)!;
        const flattened = await flattenGroup(group, token);
        expect(flattened.unreadable.map((entry) => `${entry.reference} (${entry.reason})`)).toEqual([]);
        expect(flattened.complete).toBe(true);
        expect(flattened.bases.length).toBeGreaterThan(0);
        // A base that resolved brings dozens of members with it, so a chain that silently answered
        // with nothing would not get this far.
        expect(flattened.members.length).toBeGreaterThan(30);
    }, 30_000);

    it('supplies every part field the engine throws over, from the template or from its base', async () => {
        const fsPath = writeTemplate('part', 'load_probe', 'test.load_probe');
        const document = parseText(emitContent('part', 'load_probe', 'test.load_probe').text, pathToFileURL(fsPath).href);
        const group = document.elements.find(isGroupNode)!;
        const flattened = await flattenGroup(group, token);
        const present = new Set(flattened.members.map((member) => member.name.toLowerCase()));
        const mandatory = mandatoryFieldsOf(PART_RULES);
        expect(mandatory.length).toBeGreaterThan(20);
        const missing = mandatory.filter((name) => !present.has(name.toLowerCase()));
        expect(missing).toEqual([]);
    }, 30_000);

    it('supplies every resource and bullet field the engine throws over, with no base to lean on', () => {
        // Neither of these inherits anything, so whatever they need has to be in the template itself.
        for (const [kind, cls, id] of [
            ['resource', 'Cosmoteer.Resources.ResourceRules', 'load_probe'],
            ['bullet', 'Cosmoteer.Bullets.BulletRules', 'test.load_probe'],
        ] as Array<[ContentKind, string, string]>) {
            const text = emitContent(kind, 'load_probe', id).text;
            for (const field of mandatoryFieldsOf(cls)) {
                expect(text, `the ${kind} template dropped ${field}`).toContain(`${field} =`);
            }
        }
    });

    it('points every template at an asset the install really holds', () => {
        for (const kind of ['part', 'resource', 'bullet', 'mediaEffect'] as ContentKind[]) {
            for (const asset of emitContent(kind, 'load_probe', 'test.load_probe').placeholderAssets) {
                const path = join(DATA_DIR, asset.replace(/^\.\/Data\//, ''));
                expect(existsSync(path), `${asset} is not in the install`).toBe(true);
            }
        }
    });

    it('names a part base the install really ships, with the group the reference asks for', () => {
        const text = emitContent('part', 'load_probe', 'test.load_probe').text;
        const reference = /<\.\/Data\/([^>]+)>/.exec(text)?.[1];
        expect(reference).toBeDefined();
        expect(existsSync(join(DATA_DIR, reference!))).toBe(true);
    });
});
