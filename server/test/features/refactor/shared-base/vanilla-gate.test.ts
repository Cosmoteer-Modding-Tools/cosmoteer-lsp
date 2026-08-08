import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, WorkDoneProgressReporter } from 'vscode-languageserver';
import { globalSettings } from '../../../../src/settings';
import { CosmoteerWorkspaceService } from '../../../../src/workspace/cosmoteer-workspace.service';
import { editableModRootOf } from '../../../../src/features/refactor/shared-base/shared-base.analysis-entry';
import { clearSharedBaseScanCache } from '../../../../src/features/refactor/shared-base/mod-scan';
import { scanForSharedBases } from '../../../../src/features/refactor/shared-base/shared-base.command';
import { baseIdentityOf } from '../../../../src/features/refactor/shared-base/duplicate-field.analysis';

// The gate that decides which trees the extraction may rewrite. It answers against the real install
// because the whole question is about the game's own data root, which the workspace service only
// knows once it has been initialized against it, so this self-skips without the game.
const DATA_DIR = (process.env.COSMOTEER_DATA_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Cosmoteer/Data')
    .replace(/\\/g, '/');
const WORKSHOP_DIR = (
    process.env.COSMOTEER_MODS_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/workshop/content/799600'
).replace(/\\/g, '/');
const HAVE = existsSync(DATA_DIR);

/** Any `.rules` file under a tree, so the test names a path the gate really sees. */
const someRulesFile = (root: string): string | undefined => {
    const walk = (dir: string, depth: number): string | undefined => {
        if (depth > 4) return undefined;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return undefined;
        }
        for (const entry of entries) {
            const path = join(dir, entry).replace(/\\/g, '/');
            let stats;
            try {
                stats = statSync(path);
            } catch {
                continue;
            }
            if (stats.isFile() && entry.toLowerCase().endsWith('.rules')) return path;
            if (stats.isDirectory()) {
                const found = walk(path, depth + 1);
                if (found) return found;
            }
        }
        return undefined;
    };
    return walk(root, 0);
};

let wasAllowed: boolean;

beforeAll(async () => {
    globalSettings.cosmoteerPath = DATA_DIR;
    const noop: WorkDoneProgressReporter = { begin: () => undefined, report: () => undefined, done: () => undefined };
    const service = CosmoteerWorkspaceService.instance;
    service.setConnection({
        languages: { diagnostics: { refresh: () => undefined } },
        window: { showWarningMessage: () => undefined },
    } as unknown as Connection);
    await service.initialize(DATA_DIR, noop);
    wasAllowed = globalSettings.allowEditingVanillaFiles;
});

afterAll(() => {
    globalSettings.allowEditingVanillaFiles = wasAllowed;
});

describe.skipIf(!HAVE)('which trees the shared-base extraction may rewrite', () => {
    it('leaves the game data alone by default, and it has no manifest to be found by either', () => {
        globalSettings.allowEditingVanillaFiles = false;
        const vanilla = someRulesFile(DATA_DIR);
        expect(vanilla, 'the game data holds no .rules file to test with').toBeDefined();
        expect(editableModRootOf(vanilla!)).toBeUndefined();
    });

    it('treats the data root as the project once the setting says the game data is being worked on', () => {
        globalSettings.allowEditingVanillaFiles = true;
        const vanilla = someRulesFile(DATA_DIR);
        // The game tree carries no mod manifest, so the data root itself stands in for one: it is the
        // tree the files are compared within and the directory a generated base file is placed under.
        expect(editableModRootOf(vanilla!)?.toLowerCase()).toBe(DATA_DIR.toLowerCase());
    });

    it('lets a whole sweep of the game data find real extractions in it', async () => {
        // The point of the switch: a developer working on the game's own data gets the same offer a
        // modder gets. Scanning only, nothing is written.
        globalSettings.allowEditingVanillaFiles = true;
        clearSharedBaseScanCache();
        try {
            const scan = await scanForSharedBases(
                {
                    folderPaths: async () => [DATA_DIR],
                    openDocuments: () => [],
                    applyEdit: async () => false,
                    filesChanged: () => undefined,
                },
                CancellationToken.None
            );
            expect(scan.filesScanned).toBeGreaterThan(100);
            expect(scan.plans.length).toBeGreaterThan(0);
            for (const plan of scan.plans) {
                expect(plan.baseFsPath.replace(/\\/g, '/').toLowerCase().startsWith(DATA_DIR.toLowerCase())).toBe(true);
            }
        } finally {
            clearSharedBaseScanCache();
        }
    }, 120_000);

    it('gives one base file one identity, however a file spells the path to it', () => {
        // `<./Data/ships/base_part.rules>` is read from the install root and `<../base_part.rules>`
        // from the declaring folder, and from `ships/terran` both name the very same file. Counting
        // them as two bases would halve the inheritor count the safety proof for adding to a base
        // rests on, which only becomes reachable once the game tree can be a project of its own.
        const from = `${DATA_DIR}/ships/terran`;
        const viaGameRoot = baseIdentityOf('<./Data/ships/base_part.rules>/Part', from);
        const viaRelative = baseIdentityOf('<../base_part.rules>/Part', from);
        expect(viaRelative).toBeDefined();
        expect(viaGameRoot).toBe(viaRelative);
    });

    it('never opens up somebody else installed workshop mod, whatever the setting says', () => {
        const installed = existsSync(WORKSHOP_DIR) ? someRulesFile(WORKSHOP_DIR) : undefined;
        if (!installed) return;
        for (const allowed of [false, true]) {
            globalSettings.allowEditingVanillaFiles = allowed;
            expect(editableModRootOf(installed), `workshop file was editable with the setting ${allowed}`).toBeUndefined();
        }
    });
});
