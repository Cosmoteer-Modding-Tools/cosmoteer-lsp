import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationToken, Connection, Diagnostic, WorkDoneProgressReporter } from 'vscode-languageserver';
import { FIXTURES_DIR } from '../../helpers';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, ValueNode, isGroupNode, isListNode, isValueNode } from '../../../src/core/ast/ast';
import { ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { clearNavigationMemo } from '../../../src/features/navigation/full.navigation-strategy';
import { invalidateModContext } from '../../../src/mod/mod-context';
import { clearFsCaches } from '../../../src/workspace/fs-cache';
import { CosmoteerWorkspaceService } from '../../../src/workspace/cosmoteer-workspace.service';
import {
    buildSnapshot,
    savePostUpdateBaseline,
} from '../../../src/features/post-update/post-update-baseline';
import { buildPostUpdateReport, diffSnapshots } from '../../../src/features/post-update/post-update-report';

// The only end-to-end proof available. No pre-update copy of the game tree can be obtained, so a
// real update cannot be replayed. What can be done is the other half of the claim: take a real mod,
// check it against a real game tree with the real reference validator, change the game tree the way
// an update would, check it again, and prove the report names exactly what the change broke and
// nothing else. The mod is not touched between the two passes, which is what makes every difference
// attributable to the tree.
//
// This file owns the workspace singleton, which memoizes the game root it was initialized with, so
// it cannot share a process with a test that points it somewhere else.

const token = CancellationToken.None;
const ROOT = mkdtempSync(join(tmpdir(), 'cosmo-post-update-e2e-'));
const DATA = join(ROOT, 'Data');
const MOD = join(ROOT, 'mod');
const MOD_FILE = join(MOD, 'parts', 'uses_game_data.rules');
const CACHE_HOME = join(ROOT, 'appdata');
const previousLocalAppData = process.env.LOCALAPPDATA;

const noopProgress: WorkDoneProgressReporter = {
    begin: () => undefined,
    report: () => undefined,
    done: () => undefined,
};

const mockConnection = {
    languages: { diagnostics: { refresh: () => undefined } },
    window: { showWarningMessage: () => undefined },
} as unknown as Connection;

/** Every reference value in a tree, which is what a change to the game tree can break. */
const referencesOf = (node: AbstractNode | null | undefined, out: ValueNode[] = []): ValueNode[] => {
    if (!node || typeof node !== 'object') return out;
    if (isValueNode(node) && node.valueType.type === 'Reference') out.push(node);
    const container = node as unknown as { elements?: AbstractNode[]; left?: AbstractNode; right?: AbstractNode };
    if (isGroupNode(node) || isListNode(node) || node.type === 'Document') {
        for (const child of container.elements ?? []) referencesOf(child, out);
    }
    if (container.left) referencesOf(container.left, out);
    if (container.right) referencesOf(container.right, out);
    return out;
};

/** One scan entry, plus which references produced a finding, which the messages do not name. */
interface ModCheck {
    readonly entry: readonly [string, number, number, Diagnostic[]];
    readonly failed: string[];
}

/**
 * Check the mod file the way the workspace pass does, and return the entry a scan would record.
 *
 * @returns the scan entry and the references that failed to resolve.
 */
const checkMod = async (): Promise<ModCheck> => {
    const text = readFileSync(MOD_FILE, 'utf8');
    const document = parser(lexer(text), MOD_FILE).value;
    const diagnostics: Diagnostic[] = [];
    const failed: string[] = [];
    for (const reference of referencesOf(document)) {
        const error = await ValidationForValue.callback(reference, token);
        if (!error) continue;
        failed.push(String(reference.valueType.value));
        const line = reference.position?.line ?? 0;
        diagnostics.push({
            range: { start: { line, character: 0 }, end: { line, character: 1 } },
            severity: 2,
            // The rule the server stamps on every finding of this pass.
            code: 'syntax-and-references',
            message: error.message,
        });
    }
    const stat = statSync(MOD_FILE);
    return { entry: [MOD_FILE, stat.size, Math.round(stat.mtimeMs), diagnostics], failed };
};

/**
 * Rewrite one file of the game tree copy, the way an update would, and drop everything the session
 * cached about it.
 *
 * The editor pins a game-tree file's syntax tree on its own tree node once it has read it, which a
 * real update never has to fight because the game is not updated inside a running session. Here the
 * update happens mid-process, so the pin is dropped by hand alongside the file caches.
 *
 * @param relative the file below the game `Data` root.
 * @param edit turns the old text into the new one.
 */
const rewriteGameFile = (relative: string, edit: (text: string) => string): void => {
    const path = join(DATA, relative);
    writeFileSync(path, edit(readFileSync(path, 'utf8')), 'utf8');
    const node = CosmoteerWorkspaceService.instance.findFile(relative.split('/'));
    if (node) node.content.parsedDocument = undefined;
};

describe('a synthetic game update, end to end', () => {
    beforeAll(async () => {
        process.env.LOCALAPPDATA = CACHE_HOME;
        cpSync(join(FIXTURES_DIR, 'workspace', 'Data'), DATA, { recursive: true });
        cpSync(join(FIXTURES_DIR, 'post-update-mod'), MOD, { recursive: true });
        const service = CosmoteerWorkspaceService.instance;
        service.setConnection(mockConnection);
        await service.initialize(DATA, noopProgress);
    });

    afterAll(() => {
        process.env.LOCALAPPDATA = previousLocalAppData;
        rmSync(ROOT, { recursive: true, force: true });
    });

    it('names exactly what the changed game tree broke, and nothing else', async () => {
        const before = await checkMod();
        // The mod points at one member the first version of the tree does not have yet, so the
        // recording is not trivially empty and the update has something to fix as well as break.
        expect(before.failed).toEqual(['&<./Data/b.rules>/B/AddedLater']);

        const previous = buildSnapshot({
            gameVersion: '0.29.9',
            settingsKey: 's',
            environment: { workshop: '', codeMods: '', gameBinary: '' },
            folderPaths: [MOD],
            maxProblems: 100,
            entries: [before.entry],
        });
        await savePostUpdateBaseline(DATA, [MOD], previous);

        // The update: a group the mod reads is gone, a value it reads is gone, and a member it
        // already pointed at is added. The mod itself is not touched.
        rewriteGameFile('b.rules', (text) => text.replace('InnerValue = 100', 'Nested2 { Renamed = 100 }'));
        rewriteGameFile('base.rules', (text) => text.replace('BaseOnly = 999', ''));
        rewriteGameFile('b.rules', (text) => text.replace('\tToC =', '\tAddedLater = 7\n\tToC ='));
        clearFsCaches();
        clearNavigationMemo();
        invalidateModContext();

        const after = await checkMod();
        const current = buildSnapshot({
            gameVersion: '0.30.0',
            settingsKey: 's',
            environment: { workshop: '', codeMods: '', gameBinary: '' },
            folderPaths: [MOD],
            maxProblems: 100,
            entries: [after.entry],
        });
        await savePostUpdateBaseline(DATA, [MOD], current);

        // The mod file did not move on disk, so every difference is attributable to the tree.
        const diff = diffSnapshots(previous, current);
        expect(diff.editedFiles).toEqual([]);
        expect(diff.enteredFiles).toEqual([]);
        expect(diff.leftFiles).toEqual([]);

        expect([...after.failed].sort()).toEqual([
            '&<./Data/b.rules>/B/InnerValue',
            '&<./Data/base.rules>/Base/BaseOnly',
        ]);
        // Two references broke and one was fixed. Both halves are reported, on the lines they are
        // on, which a comparison of counts alone would net out to one anonymous difference.
        expect(diff.deltas.map((delta) => [delta.kind, delta.count])).toEqual([
            ['appeared', 2],
            ['resolved', 1],
        ]);
        expect(diff.deltas[0].lines).toHaveLength(2);
        expect(diff.deltas[0]).toMatchObject({
            ruleId: 'syntax-and-references',
            path: 'parts/uses_game_data.rules',
        });

        const report = await buildPostUpdateReport({
            dataRoot: DATA,
            folderPaths: [MOD],
            wholeWorkspaceEnabled: true,
            maxProblems: 100,
            settingsKey: 's',
            entries: [after.entry],
        });
        expect(report.summary.status).toBe('compared');
        expect(report.summary.appeared).toBe(2);
        expect(report.summary.resolved).toBe(1);
        expect(report.markdown).toContain('What newly fails');
        expect(report.markdown).toContain('parts/uses_game_data.rules');
        // This tree has no game assembly, so the report has to say the version is unknown rather
        // than pass the comparison off as a proven update.
        expect(report.summary.attribution).toContain('unknownVersion');
        expect(report.markdown).toContain('What this report cannot see');
    });

    it('reports no difference at all when the game tree does not move', async () => {
        const first = await checkMod();
        clearFsCaches();
        clearNavigationMemo();
        const second = await checkMod();
        const snapshot = (gameVersion: string, check: ModCheck) =>
            buildSnapshot({
                gameVersion,
                settingsKey: 's',
                environment: { workshop: '', codeMods: '', gameBinary: '' },
                folderPaths: [MOD],
                maxProblems: 100,
                entries: [check.entry],
            });
        expect(diffSnapshots(snapshot('0.30.0', first), snapshot('0.30.1', second)).deltas).toEqual([]);
    });
});
