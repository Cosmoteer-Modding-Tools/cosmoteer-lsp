import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { uriToFsPath } from '../../../../src/features/navigation/workspace-files';
import { filePathToUri } from '../../../../src/features/navigation/navigation-strategy';
import { clearSharedBaseScanCache } from '../../../../src/features/refactor/shared-base/mod-scan';
import {
    extractSharedBase,
    SharedBaseApplyResult,
    SharedBaseHost,
    SharedBasePreviewResult,
    SharedBaseScanResult,
} from '../../../../src/features/refactor/shared-base/shared-base.command';
import { SerializedPlan } from '../../../../src/features/refactor/shared-base/plan.types';
import { FIXTURES_DIR } from '../../../helpers';

// The command driven end to end against a scratch copy of a mod whose three parts are the only
// things inheriting its base file. That shape is the one the extraction should answer by adding to
// the base rather than by writing a new one, and the preview has to describe that whole change
// without any of it happening yet.
const token = CancellationToken.None;
const NAMES = ['hull_a.rules', 'hull_b.rules', 'hull_c.rules'];

let root: string;
let written: string[] = [];
/** The uris the editor was asked to change, so the split between disk and editor can be asserted. */
let editorEdited: string[] = [];
/** Buffers the editor is pretending to hold open, which is what routes a file through `applyEdit`. */
let openBuffers: TextDocument[] = [];

const host = (): SharedBaseHost => ({
    folderPaths: async () => [root],
    openDocuments: () => openBuffers,
    filesChanged: (paths) => written.push(...paths),
    applyEdit: async (changes: Record<string, TextEdit[]>) => {
        for (const [uri, edits] of Object.entries(changes)) {
            editorEdited.push(uri);
            const fsPath = uriToFsPath(uri);
            const text = readFileSync(fsPath, { encoding: 'utf-8' });
            writeFileSync(fsPath, TextDocument.applyEdits(TextDocument.create(uri, 'rules', 0, text), edits));
        }
        return true;
    },
});

const read = (relative: string): string => readFileSync(`${root}/${relative}`, { encoding: 'utf-8' });

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sharedbase-preview-')).replace(/\\/g, '/');
    cpSync(join(FIXTURES_DIR, 'shared-base-existing-mod'), root, { recursive: true });
    clearSharedBaseScanCache();
});

afterAll(() => {
    clearSharedBaseScanCache();
    rmSync(root, { recursive: true, force: true });
});

describe('the shared-base command over a mod whose base has no other inheritor', () => {
    let plan: SerializedPlan;

    it('offers to add to the base file rather than to write another one', async () => {
        const scan = (await extractSharedBase({}, host(), token)) as SharedBaseScanResult;
        expect(scan.kind).toBe('scan');
        expect(scan.plans).toHaveLength(1);
        plan = scan.plans[0];
        expect(plan.tier).toBe('existingBase');
        expect(plan.baseFsPath.toLowerCase()).toBe(`${root}/base_hull.rules`.toLowerCase());
        expect(plan.existingBase?.groupPath).toEqual(['Part']);
        expect(plan.label).toContain('into base_hull.rules');
    });

    it('describes the whole rewrite as a diff and changes nothing doing it', async () => {
        const before = NAMES.map((name) => read(`parts/${name}`)).concat(read('base_hull.rules'));
        written = [];
        const preview = (await extractSharedBase({ plan, preview: true }, host(), token)) as SharedBasePreviewResult;
        expect(preview.kind).toBe('preview');
        expect(preview.failure).toBeUndefined();
        expect(preview.files).toBe(3);
        expect(preview.fields).toBe(3);

        // Every touched file appears once, the base file gains the three members, and the parts lose
        // them without their inheritance line moving.
        expect(preview.diff.match(/^--- a\//gm)).toHaveLength(4);
        expect(preview.diff).toContain('+\tDensity = 3');
        expect(preview.diff).toContain('-\tDensity = 3');
        expect(preview.diff).not.toContain('base_hull.rules>/Part');

        expect(NAMES.map((name) => read(`parts/${name}`)).concat(read('base_hull.rules'))).toEqual(before);
        expect(written).toEqual([]);
    });

    it('carries each changed file with its rewritten text, for a real side-by-side view', async () => {
        const preview = (await extractSharedBase({ plan, preview: true }, host(), token)) as SharedBasePreviewResult;
        // Four files change: the base being added to, and the three parts giving the fields up.
        expect(preview.changed).toHaveLength(4);
        expect(preview.omitted).toBe(0);
        // Nothing is created here, so every entry has a file on disk to be compared against.
        expect(preview.changed.every((file) => !file.created)).toBe(true);

        const base = preview.changed.find((file) => file.fsPath.endsWith('base_hull.rules'));
        expect(base?.after).toContain('\tDensity = 3');
        const part = preview.changed.find((file) => file.fsPath.endsWith('hull_a.rules'));
        expect(part?.after).not.toContain('Density = 3');
        expect(part?.after).toContain('Part : <../base_hull.rules>/Part');
    });

    it('applies exactly what the preview described, and only reaches the editor for an open file', async () => {
        // A workspace edit over a file that is not open makes the editor load it, hold it dirty and
        // give it a tab, which for a plan covering hundreds of files buries the workspace. Only the
        // one buffer the editor really holds is routed through it, so its own copy stays in step; the
        // rest are written straight to disk.
        const openPath = `${root}/parts/hull_b.rules`;
        openBuffers = [
            TextDocument.create(filePathToUri(openPath), 'rules', 1, readFileSync(openPath, { encoding: 'utf-8' })),
        ];
        editorEdited = [];
        const result = (await extractSharedBase({ plan }, host(), token)) as SharedBaseApplyResult;
        openBuffers = [];
        expect(result.kind).toBe('apply');
        expect(result.failure).toBeUndefined();
        expect(result.tier).toBe('existingBase');
        expect(editorEdited.map((uri) => uriToFsPath(uri).replace(/\\/g, '/'))).toEqual([openPath]);
        expect(result.changedFiles.map((path) => path.replace(/\\/g, '/'))).toEqual([openPath]);

        expect(read('base_hull.rules')).toBe(
            [
                'Part',
                '{',
                '\tMaxHealth = 1000',
                '\tDensity = 3',
                '\tIsRotateable = false',
                '\tCrewSpeedFactor = 0',
                '}',
                '',
            ].join('\n')
        );
        expect(read('parts/hull_a.rules')).toBe(
            [
                'Part : <../base_hull.rules>/Part',
                '{',
                '\tNameKey = "Parts/HullA"',
                '\tID = test.hull_a',
                '\tMaxHealth = 4000',
                '}',
                '',
            ].join('\n')
        );
        // The file that never reached the editor is rewritten all the same.
        expect(read('parts/hull_c.rules')).not.toContain('Density = 3');
    });
});
