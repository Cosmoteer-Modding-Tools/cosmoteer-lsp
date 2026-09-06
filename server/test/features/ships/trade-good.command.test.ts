import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CancellationToken, Connection, TextEdit, WorkDoneProgressReporter } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { clearBaseFileCache } from '../../../src/features/refactor/shared-base/base-index';
import { tradeGood } from '../../../src/features/ships/trade-good.command';
import {
    TradeGoodApplyResult,
    TradeGoodArgs,
    TradeGoodHost,
    TradeGoodScanResult,
} from '../../../src/features/ships/trade-good.types';
import { clearModRootCache } from '../../../src/mod/mod-root';
import { globalSettings } from '../../../src/settings';
import { parseText } from '../../../src/utils/ast.utils';
import {
    CosmoteerWorkspaceData,
    CosmoteerWorkspaceService,
    FileWithPath,
} from '../../../src/workspace/cosmoteer-workspace.service';
import { clearFsCaches } from '../../../src/workspace/fs-cache';
import { FIXTURES_DIR } from '../../helpers';

// The trade wizard against the stand-in install the ship commands share, whose career file has the
// trade ship template and whose basic sector has the station stock list. The mod declares a
// resource of its own, and the install declares one that does not stack. Everything is mirrored
// into a scratch copy first, because the command edits the manifest.
const SOURCE = join(FIXTURES_DIR, 'register-ship-mod').replace(/\\/g, '/');
const token = CancellationToken.None;

let ROOT = '';
let DATA_DIR = '';
let GAME_ROOT = '';
let MOD_DIR = '';

const read = (path: string): string => readFileSync(path, { encoding: 'utf-8' });

/** The parsed stand-in game root, in the shape the workspace service hands the commands. */
const gameRootFile = (): FileWithPath => {
    const text = read(GAME_ROOT);
    const content: CosmoteerWorkspaceData = { name: 'cosmoteer.rules', parsedDocument: parseText(text, GAME_ROOT) };
    return { type: 'File', name: 'cosmoteer.rules', path: GAME_ROOT, content };
};

type TestHost = TradeGoodHost & { changes: Record<string, TextEdit[]> };

/** A host whose client-side edits are captured rather than applied, so they can be read back. */
const makeHost = (): TestHost => ({
    changes: {},
    folderPaths: async () => [MOD_DIR],
    openDocuments: () => [],
    gameRoot: async () => gameRootFile(),
    dataRoot: () => DATA_DIR,
    applyEdit(changes) {
        Object.assign(this.changes, changes);
        return Promise.resolve(true);
    },
    filesChanged: () => undefined,
    existingIds: async () => new Set<string>(),
    localizedName: async (key) => ({ 'Resource/Gem': 'Gem', 'Resource/Steel': 'Steel' })[key],
});

/** The scan round, asserting it answered as one. */
const scan = async (host: TradeGoodHost): Promise<TradeGoodScanResult> => {
    const result = await tradeGood({ uri: filePathToUri(MOD_DIR) }, host, token);
    if (result.kind !== 'scan') throw new Error('expected the scan round');
    return result;
};

/** The apply round, asserting it answered as one. */
const apply = async (args: Omit<TradeGoodArgs, 'uri'>, host: TradeGoodHost): Promise<TradeGoodApplyResult> => {
    const result = await tradeGood({ uri: filePathToUri(MOD_DIR), ...args }, host, token);
    if (result.kind !== 'apply') throw new Error('expected the apply round');
    return result;
};

/** The one edit the host captured for the manifest. */
const manifestEdit = (host: TestHost): string => {
    const edits = host.changes[filePathToUri(`${MOD_DIR}/mod.rules`)];
    expect(edits).toHaveLength(1);
    return edits[0].newText;
};

/** Writes the captured manifest edit to disk, the way the editor would have. */
const commitManifest = (host: TestHost): void => {
    const path = `${MOD_DIR}/mod.rules`;
    const document = TextDocument.create(filePathToUri(path), 'cosmoteer', 1, read(path));
    writeFileSync(path, TextDocument.applyEdits(document, host.changes[filePathToUri(path)]));
    clearBaseFileCache();
    clearFsCaches();
};

/** The `AddMany` action text for one target and one inline entry, as the manifest gets it. */
const action = (target: string, entry: string): string =>
    [
        '\t{',
        '\t\tAction = AddMany',
        `\t\tAddTo = "${target}"`,
        '\t\tManyToAdd',
        '\t\t[',
        `\t\t\t${entry}`,
        '\t\t]',
        '\t}',
    ].join('\n');

const CARGO_TARGET = '<modes/career/career.rules>/BaseTradeShip/ResourcesCarried';
const STATIONS_TARGET =
    '<modes/career/sectors/sector_basic/sector_basic.rules>/Sector/TradeRoutes/StationResourceTradeDeltas';

beforeAll(async () => {
    ROOT = mkdtempSync(join(tmpdir(), 'tradegood-')).replace(/\\/g, '/');
    cpSync(SOURCE, ROOT, { recursive: true });
    DATA_DIR = `${ROOT}/steamapps/common/Cosmoteer/Data`;
    GAME_ROOT = `${DATA_DIR}/cosmoteer.rules`;
    MOD_DIR = `${ROOT}/mod`;

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
    if (ROOT) rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
    clearBaseFileCache();
    clearModRootCache();
    clearFsCaches();
    globalSettings.allowEditingVanillaFiles = false;
});

describe('putting a resource into the trade', () => {
    it("lists the mod's resources first and the game's after, each with whether it stacks and is traded", async () => {
        const result = await scan(makeHost());
        expect(result.failure).toBeUndefined();
        expect(result.modId).toBe('test.shipmod');
        // The mod's own resource leads, and the game's follow in registry order, whatever else the
        // registry lists between them.
        expect(result.resources[0]).toEqual({
            id: 'test.gem',
            name: 'Gem',
            source: 'mod',
            stackable: true,
            alreadyCarried: false,
            alreadyStocked: false,
        });
        expect(result.resources).toContainEqual({
            id: 'steel',
            name: 'Steel',
            source: 'game',
            stackable: true,
            alreadyCarried: false,
            alreadyStocked: false,
        });
        expect(result.resources).toContainEqual({
            id: 'relic',
            source: 'game',
            stackable: false,
            alreadyCarried: false,
            alreadyStocked: false,
        });
        const ids = result.resources.map((resource) => resource.id);
        expect(ids.indexOf('steel')).toBeLessThan(ids.indexOf('relic'));
        expect(result.resources.filter((resource) => resource.source === 'mod')).toHaveLength(1);
    });

    it('writes the cargo and the station entries for a rare good', async () => {
        const host = makeHost();
        const result = await apply({ resource: 'test.gem', rarity: 'rare' }, host);
        expect(result.failure).toBeUndefined();
        expect(result.resource).toBe('test.gem');
        expect(result.wiring).toEqual({ cargo: 'written', stations: 'written' });
        expect(result.manifest).toBe(`${MOD_DIR}/mod.rules`);
        expect(result.changedFiles).toEqual([`${MOD_DIR}/mod.rules`]);
        const written = manifestEdit(host);
        expect(written).toContain(
            action(CARGO_TARGET, '{ ResourceType=test.gem; RandomWeight=5; RandomQuantity=[50%, 100%]; }')
        );
        expect(written).toContain(
            action(
                STATIONS_TARGET,
                '{ ResourceType=test.gem; PercentOfTypedTiles=[80%, 90%]; PercentOfUntypedTiles=[-0.5%, 0.5%]; }'
            )
        );
    });

    it('scales the weight, the quantity and the station band with the rarity, and turns stations into buyers', async () => {
        const common = makeHost();
        await apply({ resource: 'test.gem', rarity: 'common' }, common);
        expect(manifestEdit(common)).toContain(
            '{ ResourceType=test.gem; RandomWeight=20; RandomQuantity=[75%, 100%]; }'
        );
        expect(manifestEdit(common)).toContain(
            '{ ResourceType=test.gem; PercentOfTypedTiles=[80%, 90%]; PercentOfUntypedTiles=[0%, 10%]; }'
        );

        const uncommon = makeHost();
        await apply({ resource: 'test.gem' }, uncommon);
        expect(manifestEdit(uncommon)).toContain(
            '{ ResourceType=test.gem; RandomWeight=10; RandomQuantity=[75%, 100%]; }'
        );
        expect(manifestEdit(uncommon)).toContain(
            '{ ResourceType=test.gem; PercentOfTypedTiles=[80%, 90%]; PercentOfUntypedTiles=[0%, 5%]; }'
        );

        const buying = makeHost();
        await apply({ resource: 'steel', rarity: 'common', stationsBuy: true }, buying);
        expect(manifestEdit(buying)).toContain('{ ResourceType=steel; RandomWeight=20; RandomQuantity=[75%, 100%]; }');
        expect(manifestEdit(buying)).toContain(
            '{ ResourceType=steel; PercentOfTypedTiles=[80%, 90%]; PercentOfUntypedTiles=[-10%, 0%]; }'
        );
        const rareBuying = makeHost();
        await apply({ resource: 'steel', rarity: 'rare', stationsBuy: true }, rareBuying);
        expect(manifestEdit(rareBuying)).toContain('PercentOfUntypedTiles=[-0.5%, 0%]; }');
    });

    it('refuses a resource nothing declares and one that does not stack, changing nothing', async () => {
        const unknown = makeHost();
        expect((await apply({ resource: 'unobtainium' }, unknown)).failure).toBe('unknownResource');
        expect(Object.keys(unknown.changes)).toEqual([]);
        const relic = makeHost();
        expect((await apply({ resource: 'relic' }, relic)).failure).toBe('notStackable');
        expect(Object.keys(relic.changes)).toEqual([]);
    });

    it('reports both wirings as present once the manifest carries them, and the scan says so too', async () => {
        const first = makeHost();
        await apply({ resource: 'test.gem', rarity: 'rare' }, first);
        commitManifest(first);
        expect(parser(lexer(read(`${MOD_DIR}/mod.rules`)), filePathToUri(`${MOD_DIR}/mod.rules`)).parserErrors).toEqual(
            []
        );

        const again = makeHost();
        const result = await apply({ resource: 'TEST.GEM', rarity: 'common' }, again);
        expect(result.failure).toBeUndefined();
        expect(result.wiring).toEqual({ cargo: 'present', stations: 'present' });
        expect(Object.keys(again.changes)).toEqual([]);

        const listed = (await scan(makeHost())).resources.find((resource) => resource.id === 'test.gem');
        expect(listed).toMatchObject({ alreadyCarried: true, alreadyStocked: true });
    });

    it('sees a resource an action adds through a list-valued source in another file', async () => {
        mkdirSync(`${MOD_DIR}/trade`, { recursive: true });
        writeFileSync(
            `${MOD_DIR}/trade/trade.rules`,
            'ResourcesCarried\n[\n\t{ ResourceType=steel; RandomWeight=40; RandomQuantity=[75%, 100%]; }\n]\n'
        );
        const manifest = `${MOD_DIR}/mod.rules`;
        writeFileSync(
            manifest,
            read(manifest).replace(
                '\nActions\n[\n',
                `\nActions\n[\n${['\t{', '\t\tAction = AddMany', `\t\tAddTo = "${CARGO_TARGET}"`, '\t\tManyToAdd = &<trade/trade.rules>/ResourcesCarried', '\t}'].join('\n')}\n`
            )
        );
        clearBaseFileCache();
        clearFsCaches();
        const steel = (await scan(makeHost())).resources.find((resource) => resource.id === 'steel');
        expect(steel).toMatchObject({ alreadyCarried: true, alreadyStocked: false });
        const host = makeHost();
        const result = await apply({ resource: 'steel' }, host);
        expect(result.wiring).toEqual({ cargo: 'present', stations: 'written' });
        expect(manifestEdit(host)).not.toContain('ResourcesCarried');
    });

    it('still writes the cargo entry when the install has no basic sector to stock', async () => {
        const sector = `${DATA_DIR}/modes/career/sectors/sector_basic/sector_basic.rules`;
        renameSync(sector, `${sector}.away`);
        mkdirSync(`${MOD_DIR}/resources/ore`, { recursive: true });
        writeFileSync(`${MOD_DIR}/resources/ore/ore.rules`, 'ID = test.ore\nMaxStackSize = 10\n');
        try {
            clearFsCaches();
            const host = makeHost();
            const result = await apply({ resource: 'test.ore', rarity: 'rare' }, host);
            expect(result.failure).toBeUndefined();
            expect(result.wiring).toEqual({ cargo: 'written', stations: 'noTarget' });
            const written = manifestEdit(host);
            expect(written).toContain(
                action(CARGO_TARGET, '{ ResourceType=test.ore; RandomWeight=5; RandomQuantity=[50%, 100%]; }')
            );
            expect(written).not.toContain('StationResourceTradeDeltas');
            const traded = makeHost();
            expect((await apply({ resource: 'test.gem' }, traded)).wiring).toEqual({
                cargo: 'present',
                stations: 'noTarget',
            });
            expect(Object.keys(traded.changes)).toEqual([]);
        } finally {
            renameSync(`${sector}.away`, sector);
        }
    });
});
