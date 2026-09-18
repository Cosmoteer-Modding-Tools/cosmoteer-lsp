// Every command the server executes, as a table: the id, the preparation the command needs, and
// what it runs.
//
// This used to be two lists that had to agree by hand: a 340-line `if (params.command === …)` chain
// in command.handlers.ts, and a separate array of ids here for `executeCommandProvider`. A command
// added to one and not the other either went unadvertised or fell through to `undefined`, and
// nothing said so. Now the ids are derived from the table, so the two cannot drift.
//
// The chain also repeated one envelope sixteen times: build the rooting indexes, open an fs trust
// window, run, log a failure, close the window. Those are the `needsRooting` and `trustFs` fields,
// and {@link runServerCommand} applies them once.

import { CancellationToken } from 'vscode-languageserver/node';
import { OPEN_IN_DECOMPILER_COMMAND } from '../features/hover/decompiler-link';
import { OpenInDecompilerArgs, openInDecompiler } from '../features/hover/decompiler-launcher';
import { MIGRATE_WORKSPACE_COMMAND } from '../features/migration/migrate-workspace';
import { MIGRATE_SYMBOL_COMMAND } from '../features/migration/migrate-symbol';
import { MigrateSymbolArgs } from '../../../shared/migration.types';
import { BUILD_MOD_SCHEMA_COMMAND } from '../features/mod-schema/mod-schema';
import {
    EXTRACT_LOCALIZATION_KEY_COMMAND,
    buildExtractLocalizationKeyEdit,
} from '../features/refactor/extract-localization-key';
import {
    ExtractLocalizationKeyArgs,
    ExtractLocalizationKeyResult,
} from '../../../shared/extract-localization-key.types';
import { EXTRACT_SHARED_BASE_COMMAND, extractSharedBase } from '../features/refactor/shared-base/shared-base.command';
import { ExtractSharedBaseArgs } from '../../../shared/shared-base.types';
import { EXTRACT_GROUP_COMMAND, extractGroupToFile } from '../features/refactor/extract-group/extract-group.command';
import { ExtractGroupArgs } from '../../../shared/extract-group.types';
import {
    CREATE_COMPONENT_COMMAND,
    createComponent,
} from '../features/refactor/create-component/create-component.command';
import { CreateComponentArgs } from '../../../shared/create-component.types';
import {
    REGISTER_PART_IN_SHIP_COMMAND,
    registerPartInShip,
} from '../features/refactor/register-part/register-part.command';
import { RegisterPartArgs } from '../../../shared/register-part.types';
import { OVERRIDE_IN_MOD_COMMAND, overrideInMod } from '../features/refactor/override-in-mod/override-in-mod.command';
import { OverrideInModArgs } from '../../../shared/override-in-mod.types';
import { CLONE_DECLARATION_COMMAND, cloneDeclaration } from '../features/refactor/clone-declaration/clone.command';
import { CloneDeclarationArgs } from '../../../shared/clone-declaration.types';
import {
    INSERT_SCHEMA_FIELD_COMMAND,
    InsertSchemaFieldArgs,
    InsertSchemaFieldResult,
    buildInsertSchemaFieldEdit,
} from '../features/schema-search/schema-search.insert';
import { RUN_IN_COSMOTEER_COMMAND, RunGameHost, runInCosmoteer } from '../features/run-game/run-game.command';
import { RunGameArgs } from '../../../shared/run-game.types';
import { IMPORT_GAME_LOG_COMMAND, GameLogHost, importGameLog } from '../features/game-log/import-game-log.command';
import { NEW_CONTENT_COMMAND, newContent } from '../features/refactor/new-content/new-content.command';
import { NewContentArgs } from '../../../shared/new-content.types';
import { NEW_MOD_COMMAND, newMod } from '../features/refactor/new-mod/new-mod.command';
import { NewModArgs } from '../../../shared/new-mod.types';
import { REGISTER_SHIP_COMMAND, registerShip } from '../features/ships/register-ship.command';
import { RegisterShipArgs } from '../features/ships/register-ship.types';
import { NEW_FACTION_COMMAND, newFaction } from '../features/ships/new-faction.command';
import { NewFactionArgs } from '../features/ships/new-faction.types';
import { NEW_NEBULA_COMMAND, newNebula } from '../features/ships/new-nebula.command';
import { NewNebulaArgs } from '../features/ships/new-nebula.types';
import { NEW_GALAXY_SIZE_COMMAND, newGalaxySize } from '../features/ships/new-galaxy-size.command';
import { NewGalaxySizeArgs } from '../features/ships/new-galaxy-size.types';
import { NEW_ASTEROID_TYPE_COMMAND, newAsteroidType } from '../features/ships/new-asteroid-type.command';
import { NewAsteroidTypeArgs } from '../features/ships/new-asteroid-type.types';
import { NEW_PLANET_COMMAND, newPlanet } from '../features/ships/new-planet.command';
import { NewPlanetArgs } from '../features/ships/new-planet.types';
import { TRADE_GOOD_COMMAND, tradeGood } from '../features/ships/trade-good.command';
import { TradeGoodArgs } from '../features/ships/trade-good.types';
import { NEW_TECH_COMMAND, newTech } from '../features/ships/new-tech.command';
import { NewTechArgs } from '../features/ships/new-tech.types';
import { rebuildModSchema } from './mod-schema';
import { migrateWorkspace } from './migration';
import { connection, documents } from './context';
import { ensureFragmentRooting } from './fragment-rooting';
import { ensureParserResult, openBufferReadOverride } from './open-documents';
import { beginFsTrustWindow, endFsTrustWindow, invalidateFsPath } from '../workspace/fs-cache';
import { bumpWorkspaceScanEpoch } from './scan-epoch';
import { diagnosticsCache } from './document-caches';
import { LocalizationKeyIndex } from '../features/completion/localization-key.index';
import { filePathToUri } from '../document/reference-path';
import { uriToFsPath } from '../workspace/workspace-files';
import { findModRoot } from '../mod/mod-root';
import { traceFailure } from '../utils/cancellation';
import { reachableFileFilter } from './validation-scope';
import {
    cloneHost,
    createComponentHost,
    extractGroupHost,
    newContentHost,
    newFactionHost,
    newTechHost,
    registerPartHost,
    registerShipHost,
    sharedBaseHost,
} from './hosts';

/** One command the server executes, with the preparation the runner does for it. */
export interface ServerCommand {
    readonly id: string;
    /**
     * Builds the fragment-rooting indexes before the command runs. Needed by every command that
     * resolves a reference or walks an inheritance chain: the code action that offered the command
     * never waits for those indexes, so this is where they are ensured.
     */
    readonly needsRooting?: boolean;
    /**
     * Trusts the fs caches while the command runs. Every one of these re-reads the same directories
     * repeatedly and writes nothing until the end, so a stat per read buys nothing.
     */
    readonly trustFs?: boolean;
    run(args: unknown): Promise<unknown>;
}

/** The token every command runs under: these are user-initiated and run to completion. */
const token = CancellationToken.None;

export const SERVER_COMMAND_TABLE: readonly ServerCommand[] = [
    // The "Open in decompiler" hover link (see decompiler-link.ts), which spawns the user's own
    // decompiler locally.
    {
        id: OPEN_IN_DECOMPILER_COMMAND,
        run: async (args) => {
            await openInDecompiler(args as OpenInDecompilerArgs, connection);
            return undefined;
        },
    },
    // The workspace migration computes and applies a WorkspaceEdit and answers with a summary the
    // client displays. It runs on the server so both clients share one implementation.
    {
        id: MIGRATE_WORKSPACE_COMMAND,
        run: (args) => migrateWorkspace(args as { removeDeadFields?: boolean; dryRun?: boolean }),
    },
    // The same migration narrowed to one deprecation and to the mod the offer came from.
    {
        id: MIGRATE_SYMBOL_COMMAND,
        run: async (raw) => {
            const args = raw as MigrateSymbolArgs;
            if (!args.symbol || !args.uri) return null;
            return migrateWorkspace({
                dryRun: args.dryRun === true,
                symbol: args.symbol,
                scopeFsPath: uriToFsPath(args.uri),
            });
        },
    },
    { id: BUILD_MOD_SCHEMA_COMMAND, run: () => rebuildModSchema() },
    {
        id: EXTRACT_LOCALIZATION_KEY_COMMAND,
        run: async (raw) => {
            const args = raw as ExtractLocalizationKeyArgs;
            const source = documents.get(args.uri);
            if (!source) return { key: args.key, changedFiles: [], failure: 'stale' } as ExtractLocalizationKeyResult;
            const plan = await buildExtractLocalizationKeyEdit(args, source, token, openBufferReadOverride()).catch(
                (e) => {
                    traceFailure(e);
                    return null;
                }
            );
            if (!plan) return null;
            if (!plan.edit) return { key: plan.key, changedFiles: [], failure: plan.failure };
            const applied = (await connection.workspace.applyEdit({ changes: plan.edit.changes })).applied;
            if (!applied) return { key: plan.key, changedFiles: [], failure: 'editRejected' };
            // The strings files now declare a key nothing has indexed yet. The watcher reports them
            // once the client writes them out, this only keeps the window before that from
            // validating the freshly pointed-at key as missing.
            for (const path of plan.changedFiles) {
                invalidateFsPath(path);
                LocalizationKeyIndex.instance.markDirty(filePathToUri(path));
            }
            diagnosticsCache.clear();
            bumpWorkspaceScanEpoch();
            return { key: plan.key, changedFiles: plan.changedFiles } as ExtractLocalizationKeyResult;
        },
    },
    // Lifting the fields several files repeat into one base file. It owns its progress reporter
    // rather than taking one from the runner, because only the scanning half of it is slow enough
    // to be worth reporting.
    {
        id: EXTRACT_SHARED_BASE_COMMAND,
        trustFs: true,
        run: async (raw) => {
            const args = raw as ExtractSharedBaseArgs;
            const progress = args.plan ? undefined : await connection.window.createWorkDoneProgress();
            progress?.begin('Looking for shared bases', 0, '', false);
            try {
                const inScope = await reachableFileFilter(token);
                return await extractSharedBase(args, sharedBaseHost(progress, inScope), token);
            } finally {
                progress?.done();
            }
        },
    },
    // Moving an inline block into a file of its own. It runs on the server because it writes a file
    // and re-expresses every path the block carries against the folder that file lands in.
    {
        id: EXTRACT_GROUP_COMMAND,
        run: (args) => extractGroupToFile(args as ExtractGroupArgs, extractGroupHost(), token),
    },
    // Declaring a component a part references but never writes. It runs on the server because where
    // the declaration goes is a question about the file's shape, which the client cannot ask.
    {
        id: CREATE_COMPONENT_COMMAND,
        run: (args) => createComponent(args as CreateComponentArgs, createComponentHost(), token),
    },
    {
        id: REGISTER_PART_IN_SHIP_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => registerPartInShip(args as RegisterPartArgs, registerPartHost(), token),
    },
    // Writing an `Overrides` action for a value of the game's own files. It runs on the server
    // because it writes into the mod's manifest and, for the fragment shape, creates a file, so both
    // clients share one implementation of something that changes the user's project.
    {
        id: OVERRIDE_IN_MOD_COMMAND,
        trustFs: true,
        run: (args) => overrideInMod(args as OverrideInModArgs, registerPartHost(), token),
    },
    {
        id: CLONE_DECLARATION_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => cloneDeclaration(args as CloneDeclarationArgs, cloneHost(), token),
    },
    // Creating a content file and wiring it into the game are one command, because a file nothing
    // registers is typed by nothing and skipped by the whole-workspace pass, so an author would see
    // every symptom of "the editor does not know this file" and none of the cause.
    {
        id: NEW_CONTENT_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => newContent(args as NewContentArgs, newContentHost(), token),
    },
    // Putting saved ships into a faction's spawn pool: the blueprints are read, judged against the
    // game's own figures and written into the mod's builtin_ships tree, so the part walk and the
    // registries need the same rooting the part table does.
    {
        id: REGISTER_SHIP_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => registerShip(args as RegisterShipArgs, registerShipHost(), token),
    },
    // Creating a faction writes the files the galaxy generator needs beside the faction itself, and
    // wires each of them in from the manifest, which is the same read of the mod's manifests the
    // content command does.
    {
        id: NEW_FACTION_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => newFaction(args as NewFactionArgs, newFactionHost(), token),
    },
    // A nebula and a galaxy size are built on the game's own files the same way a faction is, and
    // wired in from the manifest the same way, so they share the content host and gate.
    {
        id: NEW_NEBULA_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => newNebula(args as NewNebulaArgs, newContentHost(), token),
    },
    {
        id: NEW_GALAXY_SIZE_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => newGalaxySize(args as NewGalaxySizeArgs, newContentHost(), token),
    },
    // A planet and a trade good are built on the game's own files the same way a nebula is, and both
    // pickers show names from the language files, which the ship host already reads.
    {
        id: NEW_PLANET_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) =>
            newPlanet(
                args as NewPlanetArgs,
                { ...newContentHost(), localizedName: registerShipHost().localizedName },
                token
            ),
    },
    {
        id: TRADE_GOOD_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) =>
            tradeGood(
                args as TradeGoodArgs,
                { ...newContentHost(), localizedName: registerShipHost().localizedName },
                token
            ),
    },
    // A tech reads the mod's own parts and the game's tech tree, with names from the language files.
    {
        id: NEW_TECH_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => newTech(args as NewTechArgs, newTechHost(), token),
    },
    // An asteroid type is built on the game's own asteroid class and registries the same way, and
    // the ship host names the resources through the language files.
    {
        id: NEW_ASTEROID_TYPE_COMMAND,
        needsRooting: true,
        trustFs: true,
        run: (args) => newAsteroidType(args as NewAsteroidTypeArgs, registerShipHost(), token),
    },
    // Creating the mod itself runs on the server too: where the game loads mods from, which ids are
    // already taken and which game versions the install is at are all answers the server already
    // has, and both clients would otherwise each need their own.
    { id: NEW_MOD_COMMAND, run: (args) => newMod(args as NewModArgs, token) },
    // What the game itself said the last time it loaded this mod. Read on the server because it
    // walks the user's save folder and re-reads the named files to place each finding, and because
    // both clients then publish the same findings in their own way.
    {
        id: IMPORT_GAME_LOG_COMMAND,
        run: (args) => {
            const host: GameLogHost = { openText: (uri) => documents.get(uri)?.getText() };
            return importGameLog(args as { uri?: string }, host, token);
        },
    },
    // Linking the mod into the game, enabling it and starting the game all happen on the server, so
    // both clients share one implementation of a flow that writes into the user's game settings.
    {
        id: RUN_IN_COSMOTEER_COMMAND,
        run: (raw) => {
            const args = raw as RunGameArgs;
            const host: RunGameHost = {
                modRoot: () => (args.uri ? findModRoot(args.uri) : null),
                reportError: (message) => void connection.window.showErrorMessage(message),
            };
            return runInCosmoteer(args, host);
        },
    },
    {
        id: INSERT_SCHEMA_FIELD_COMMAND,
        // The caret's class is resolved through inheritance, which needs a rooted fragment index.
        needsRooting: true,
        run: async (raw) => {
            const args = raw as InsertSchemaFieldArgs;
            const document = documents.get(args.uri);
            const parserResult = ensureParserResult(args.uri);
            if (!document || !parserResult) return { inserted: false, failure: 'stale' } as InsertSchemaFieldResult;
            const plan = await buildInsertSchemaFieldEdit(args, document, parserResult, token).catch((e) => {
                traceFailure(e);
                return null;
            });
            if (!plan) return null;
            if ('failure' in plan) return { inserted: false, failure: plan.failure } as InsertSchemaFieldResult;
            const applied = (await connection.workspace.applyEdit({ changes: { [args.uri]: [plan.edit] } })).applied;
            return {
                inserted: applied,
                field: plan.field,
                failure: applied ? undefined : 'editRejected',
            } as InsertSchemaFieldResult;
        },
    },
];

/** The commands by id, which is how `workspace/executeCommand` finds the one it was handed. */
const byId = new Map(SERVER_COMMAND_TABLE.map((command) => [command.id, command]));

/**
 * Every command the server executes, which is what it declares in `executeCommandProvider`.
 *
 * Derived from the table rather than written out beside it, so a command cannot be implemented
 * without being advertised or advertised without being implemented. The language client registers
 * an editor command for each of these ids, so one that collides with a command a client registers
 * itself throws while the client is initializing and takes the whole server down with it. Nothing
 * about that failure points at the collision, so the tripwire is worth keeping.
 */
export const SERVER_COMMANDS: readonly string[] = SERVER_COMMAND_TABLE.map((command) => command.id);

/**
 * Runs one server command with the preparation it declares, answering null for a command that
 * failed and undefined for one this server does not implement.
 *
 * @param id the command id the client asked for.
 * @param rawArguments the arguments the client sent, of which only the first is ever read.
 * @returns whatever the command answers, or null when it threw.
 */
export const runServerCommand = async (id: string, rawArguments: unknown[] | undefined): Promise<unknown> => {
    const command = byId.get(id);
    if (!command) return undefined;
    const args = rawArguments?.[0] ?? {};
    if (command.needsRooting) await ensureFragmentRooting(token);
    if (command.trustFs) beginFsTrustWindow();
    try {
        return await command.run(args);
    } catch (e) {
        traceFailure(e);
        return null;
    } finally {
        if (command.trustFs) endFsTrustWindow();
    }
};
