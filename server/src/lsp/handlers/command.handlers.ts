import { CancellationToken } from 'vscode-languageserver/node';
import { OPEN_IN_DECOMPILER_COMMAND } from '../../features/hover/decompiler-link';
import { OpenInDecompilerArgs, openInDecompiler } from '../../features/hover/decompiler-launcher';
import { MIGRATE_WORKSPACE_COMMAND } from '../../features/migration/migrate-workspace';
import { MIGRATE_SYMBOL_COMMAND } from '../../features/migration/migrate-symbol';
import { MigrateSymbolArgs } from '../../features/migration/migration.types';
import { BUILD_MOD_SCHEMA_COMMAND } from '../../features/mod-schema/mod-schema';
import {
    EXTRACT_LOCALIZATION_KEY_COMMAND,
    ExtractLocalizationKeyArgs,
    ExtractLocalizationKeyResult,
    buildExtractLocalizationKeyEdit,
} from '../../features/refactor/extract-localization-key';
import {
    EXTRACT_SHARED_BASE_COMMAND,
    extractSharedBase,
} from '../../features/refactor/shared-base/shared-base.command';
import { ExtractSharedBaseArgs } from '../../features/refactor/shared-base/shared-base.types';
import { EXTRACT_GROUP_COMMAND, extractGroupToFile } from '../../features/refactor/extract-group/extract-group.command';
import { ExtractGroupArgs } from '../../features/refactor/extract-group/extract-group.types';
import {
    CREATE_COMPONENT_COMMAND,
    createComponent,
} from '../../features/refactor/create-component/create-component.command';
import { CreateComponentArgs } from '../../features/refactor/create-component/create-component.types';
import {
    REGISTER_PART_IN_SHIP_COMMAND,
    registerPartInShip,
} from '../../features/refactor/register-part/register-part.command';
import { RegisterPartArgs } from '../../features/refactor/register-part/register-part.types';
import {
    OVERRIDE_IN_MOD_COMMAND,
    overrideInMod,
} from '../../features/refactor/override-in-mod/override-in-mod.command';
import { OverrideInModArgs } from '../../features/refactor/override-in-mod/override-in-mod.types';
import { CLONE_DECLARATION_COMMAND, cloneDeclaration } from '../../features/refactor/clone-declaration/clone.command';
import { CloneDeclarationArgs } from '../../features/refactor/clone-declaration/clone.types';
import { NEW_CONTENT_COMMAND, newContent } from '../../features/refactor/new-content/new-content.command';
import { NEW_MOD_COMMAND, newMod } from '../../features/refactor/new-mod/new-mod.command';
import { REGISTER_SHIP_COMMAND, registerShip } from '../../features/ships/register-ship.command';
import { RegisterShipArgs } from '../../features/ships/register-ship.types';
import { NEW_FACTION_COMMAND, newFaction } from '../../features/ships/new-faction.command';
import { NewFactionArgs } from '../../features/ships/new-faction.types';
import { NEW_NEBULA_COMMAND, newNebula } from '../../features/ships/new-nebula.command';
import { NewNebulaArgs } from '../../features/ships/new-nebula.types';
import { NEW_GALAXY_SIZE_COMMAND, newGalaxySize } from '../../features/ships/new-galaxy-size.command';
import { NewGalaxySizeArgs } from '../../features/ships/new-galaxy-size.types';
import { NEW_ASTEROID_TYPE_COMMAND, newAsteroidType } from '../../features/ships/new-asteroid-type.command';
import { NewAsteroidTypeArgs } from '../../features/ships/new-asteroid-type.types';
import { NEW_PLANET_COMMAND, newPlanet } from '../../features/ships/new-planet.command';
import { NewPlanetArgs } from '../../features/ships/new-planet.types';
import { TRADE_GOOD_COMMAND, tradeGood } from '../../features/ships/trade-good.command';
import { TradeGoodArgs } from '../../features/ships/trade-good.types';
import { NEW_TECH_COMMAND, newTech } from '../../features/ships/new-tech.command';
import { NewTechArgs } from '../../features/ships/new-tech.types';
import { NewModArgs } from '../../features/refactor/new-mod/new-mod.types';
import { NewContentArgs } from '../../features/refactor/new-content/new-content.types';
import { GameLogHost, IMPORT_GAME_LOG_COMMAND, importGameLog } from '../../features/game-log/import-game-log.command';
import {
    RUN_IN_COSMOTEER_COMMAND,
    RunGameArgs,
    RunGameHost,
    runInCosmoteer,
} from '../../features/run-game/run-game.command';
import {
    INSERT_SCHEMA_FIELD_COMMAND,
    InsertSchemaFieldArgs,
    InsertSchemaFieldResult,
    buildInsertSchemaFieldEdit,
} from '../../features/schema-search/schema-search.insert';
import { LocalizationKeyIndex } from '../../features/completion/localization-key.index';
import { findModRoot } from '../../mod/mod-root';
import { beginFsTrustWindow, endFsTrustWindow, invalidateFsPath } from '../../workspace/fs-cache';
import { filePathToUri } from '../../features/navigation/navigation-strategy';
import { uriToFsPath } from '../../features/navigation/workspace-files';
import { globalSettings } from '../../settings';
import { connection, documents } from '../context';
import { diagnosticsCache } from '../document-caches';
import { ensureFragmentRooting } from '../fragment-rooting';
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
} from '../hosts';
import { migrateWorkspace } from '../migration';
import { rebuildModSchema } from '../mod-schema';
import { ensureParserResult, openBufferReadOverride } from '../open-documents';
import { bumpWorkspaceScanEpoch } from '../scan-epoch';
import { reachableFileFilter } from '../validation-scope';

/**
 * Registers `workspace/executeCommand`. Every command here changes something outside the file the
 * caret is in, which is why it runs on the server: one implementation, and both clients only
 * trigger it and render the summary it answers with.
 */
export function register(): void {
    // The "Open in decompiler" hover link (see decompiler-link.ts) and the workspace migration. Both
    // clients route them here as plain workspace/executeCommand: the decompiler command spawns the
    // user's decompiler locally, the migration computes and applies a WorkspaceEdit and answers with a
    // summary the client displays.
    connection.onExecuteCommand(async (params) => {
        if (params.command === OPEN_IN_DECOMPILER_COMMAND) {
            await openInDecompiler((params.arguments?.[0] ?? {}) as OpenInDecompilerArgs, connection).catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
            });
            return;
        }
        if (params.command === MIGRATE_WORKSPACE_COMMAND) {
            return await migrateWorkspace(
                (params.arguments?.[0] ?? {}) as { removeDeadFields?: boolean; dryRun?: boolean }
            ).catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
                return null;
            });
        }

        // The same migration narrowed to one deprecation and to the mod the offer came from. It runs on
        // the server for the same reason the whole-workspace one does: one implementation works the
        // rewrite out and both clients only trigger it and show the summary.
        if (params.command === MIGRATE_SYMBOL_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as MigrateSymbolArgs;
            if (!args.symbol || !args.uri) return null;
            return await migrateWorkspace({
                dryRun: args.dryRun === true,
                symbol: args.symbol,
                scopeFsPath: uriToFsPath(args.uri),
            }).catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
                return null;
            });
        }
        if (params.command === BUILD_MOD_SCHEMA_COMMAND) {
            return await rebuildModSchema().catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
                return null;
            });
        }
        if (params.command === EXTRACT_LOCALIZATION_KEY_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as ExtractLocalizationKeyArgs;
            const source = documents.get(args.uri);
            if (!source) return { key: args.key, changedFiles: [], failure: 'stale' } as ExtractLocalizationKeyResult;
            const plan = await buildExtractLocalizationKeyEdit(
                args,
                source,
                CancellationToken.None,
                openBufferReadOverride()
            ).catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
                return null;
            });
            if (!plan) return null;
            if (!plan.edit) return { key: plan.key, changedFiles: [], failure: plan.failure };
            const applied = (await connection.workspace.applyEdit({ changes: plan.edit.changes })).applied;
            if (!applied) return { key: plan.key, changedFiles: [], failure: 'editRejected' };
            // The strings files now declare a key nothing has indexed yet. The watcher reports them once
            // the client writes them out, this only keeps the window before that from validating the
            // freshly pointed-at key as missing.
            for (const path of plan.changedFiles) {
                invalidateFsPath(path);
                LocalizationKeyIndex.instance.markDirty(filePathToUri(path));
            }
            diagnosticsCache.clear();
            bumpWorkspaceScanEpoch();
            return { key: plan.key, changedFiles: plan.changedFiles } as ExtractLocalizationKeyResult;
        }
        if (params.command === EXTRACT_SHARED_BASE_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as ExtractSharedBaseArgs;
            const progress = args.plan ? undefined : await connection.window.createWorkDoneProgress();
            progress?.begin('Looking for shared bases', 0, '', false);
            // Trust the fs caches for the pass, like the diagnostic scan and the migration do: the sweep
            // re-reads the same directories constantly, and nothing edits files until the end.
            beginFsTrustWindow();
            try {
                const inScope = await reachableFileFilter(CancellationToken.None);
                const host = sharedBaseHost(progress, inScope);
                return await extractSharedBase(args, host, CancellationToken.None).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
                progress?.done();
            }
        }
        // Moving an inline block into a file of its own. It runs on the server because it writes a
        // file and re-expresses every path the block carries against the folder that file lands in.
        if (params.command === EXTRACT_GROUP_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as ExtractGroupArgs;
            return await extractGroupToFile(args, extractGroupHost(), CancellationToken.None).catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
                return null;
            });
        }
        // Declaring a component a part references but never writes. It runs on the server because
        // where the declaration goes is a question about the file's shape, which the client cannot ask.
        if (params.command === CREATE_COMPONENT_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as CreateComponentArgs;
            return await createComponent(args, createComponentHost(), CancellationToken.None).catch(
                (e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                }
            );
        }
        if (params.command === REGISTER_PART_IN_SHIP_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as RegisterPartArgs;
            // The ship walk resolves references, which needs the fragment-rooting indexes built. The code
            // action that offered this never waits for them, so this is where they are ensured.
            await ensureFragmentRooting(CancellationToken.None);
            // Trust the fs caches for the pass, like the shared-base extraction does: the ship and
            // manifest reads hit the same directories repeatedly, and nothing is written until the end.
            beginFsTrustWindow();
            try {
                return await registerPartInShip(args, registerPartHost(), CancellationToken.None).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // Writing an `Overrides` action for a value of the game's own files. It runs on the server
        // because it writes into the mod's manifest and, for the fragment shape, creates a file, so
        // both clients share one implementation of something that changes the user's project.
        if (params.command === OVERRIDE_IN_MOD_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as OverrideInModArgs;
            // Trust the fs caches for the pass, like the part registration does: the manifest reads
            // hit the same directories repeatedly, and nothing is written until the end.
            beginFsTrustWindow();
            try {
                return await overrideInMod(args, registerPartHost(), CancellationToken.None).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        if (params.command === CLONE_DECLARATION_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as CloneDeclarationArgs;
            // The copy reads the source's whole inheritance chain, which needs the fragment-rooting
            // indexes built. The code action that offered this never waits for them, so this is where
            // they are ensured.
            await ensureFragmentRooting(CancellationToken.None);
            // Trust the fs caches for the pass, like the shared-base extraction does: a part folder is
            // read directory by directory and nothing is written until the end.
            beginFsTrustWindow();
            try {
                return await cloneDeclaration(args, cloneHost(), CancellationToken.None).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // Creating a content file and wiring it into the game are one command, because a file nothing
        // registers is typed by nothing and skipped by the whole-workspace pass, so an author would see
        // every symptom of "the editor does not know this file" and none of the cause.
        if (params.command === NEW_CONTENT_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as NewContentArgs;
            // The ship walk resolves references, which needs the fragment-rooting indexes built, exactly
            // as the part registration this command hands off to does.
            await ensureFragmentRooting(CancellationToken.None);
            // Trust the fs caches for the pass: the registry, manifest and id reads hit the same
            // directories repeatedly, and nothing is written until the end.
            beginFsTrustWindow();
            try {
                return await newContent(args, newContentHost(), CancellationToken.None).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // Putting saved ships into a faction's spawn pool: the blueprints are read, judged against
        // the game's own figures and written into the mod's builtin_ships tree, so the part walk
        // and the registries need the same rooting the part table does.
        if (params.command === REGISTER_SHIP_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as RegisterShipArgs;
            await ensureFragmentRooting(CancellationToken.None);
            beginFsTrustWindow();
            try {
                return await registerShip(args, registerShipHost(), CancellationToken.None).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // Creating a faction writes the files the galaxy generator needs beside the faction itself,
        // and wires each of them in from the manifest, which is the same read of the mod's manifests
        // the content command does.
        if (params.command === NEW_FACTION_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as NewFactionArgs;
            await ensureFragmentRooting(CancellationToken.None);
            beginFsTrustWindow();
            try {
                return await newFaction(args, newFactionHost(), CancellationToken.None).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // A nebula and a galaxy size are built on the game's own files the same way a faction is,
        // and wired in from the manifest the same way, so they share the faction's host and gate.
        if (params.command === NEW_NEBULA_COMMAND || params.command === NEW_GALAXY_SIZE_COMMAND) {
            await ensureFragmentRooting(CancellationToken.None);
            beginFsTrustWindow();
            try {
                const run =
                    params.command === NEW_NEBULA_COMMAND
                        ? newNebula((params.arguments?.[0] ?? {}) as NewNebulaArgs, newContentHost(), CancellationToken.None)
                        : newGalaxySize((params.arguments?.[0] ?? {}) as NewGalaxySizeArgs, newContentHost(), CancellationToken.None);
                return await run.catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // A planet and a trade good are built on the game's own files the same way a nebula is, and
        // both pickers show names from the language files, which the ship host already reads.
        if (params.command === NEW_PLANET_COMMAND || params.command === TRADE_GOOD_COMMAND) {
            await ensureFragmentRooting(CancellationToken.None);
            beginFsTrustWindow();
            try {
                const host = { ...newContentHost(), localizedName: registerShipHost().localizedName };
                const run =
                    params.command === NEW_PLANET_COMMAND
                        ? newPlanet((params.arguments?.[0] ?? {}) as NewPlanetArgs, host, CancellationToken.None)
                        : tradeGood((params.arguments?.[0] ?? {}) as TradeGoodArgs, host, CancellationToken.None);
                return await run.catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // A tech reads the mod's own parts and the game's tech tree, with names from the language files.
        if (params.command === NEW_TECH_COMMAND) {
            await ensureFragmentRooting(CancellationToken.None);
            beginFsTrustWindow();
            try {
                return await newTech((params.arguments?.[0] ?? {}) as NewTechArgs, newTechHost(), CancellationToken.None).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // An asteroid type is built on the game's own asteroid class and registries the same way, and
        // the ship host names the resources through the language files.
        if (params.command === NEW_ASTEROID_TYPE_COMMAND) {
            await ensureFragmentRooting(CancellationToken.None);
            beginFsTrustWindow();
            try {
                return await newAsteroidType(
                    (params.arguments?.[0] ?? {}) as NewAsteroidTypeArgs,
                    registerShipHost(),
                    CancellationToken.None
                ).catch((e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                });
            } finally {
                endFsTrustWindow();
            }
        }
        // Creating the mod itself runs on the server too: where the game loads mods from, which ids
        // are already taken and which game versions the install is at are all answers the server
        // already has, and both clients would otherwise each need their own.
        if (params.command === NEW_MOD_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as NewModArgs;
            return await newMod(args, CancellationToken.None).catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
                return null;
            });
        }
        // What the game itself said the last time it loaded this mod. Read on the server because it
        // walks the user's save folder and re-reads the named files to place each finding, and because
        // both clients then publish the same findings in their own way.
        if (params.command === IMPORT_GAME_LOG_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as { uri?: string };
            const host: GameLogHost = { openText: (uri) => documents.get(uri)?.getText() };
            return await importGameLog(args, host, CancellationToken.None).catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
                return null;
            });
        }
        // Linking the mod into the game, enabling it and starting the game all happen on the server, so
        // both clients share one implementation of a flow that writes into the user's game settings.
        if (params.command === RUN_IN_COSMOTEER_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as RunGameArgs;
            const host: RunGameHost = {
                modRoot: () => (args.uri ? findModRoot(args.uri) : null),
                reportError: (message) => void connection.window.showErrorMessage(message),
            };
            return await runInCosmoteer(args, host).catch((e) => {
                if (globalSettings.trace.server === 'messages') console.error(e);
                return null;
            });
        }
        if (params.command === INSERT_SCHEMA_FIELD_COMMAND) {
            const args = (params.arguments?.[0] ?? {}) as InsertSchemaFieldArgs;
            const document = documents.get(args.uri);
            const parserResult = ensureParserResult(args.uri);
            if (!document || !parserResult) return { inserted: false, failure: 'stale' } as InsertSchemaFieldResult;
            // The caret's class is resolved through inheritance, which needs a rooted fragment index.
            await ensureFragmentRooting(CancellationToken.None);
            const plan = await buildInsertSchemaFieldEdit(args, document, parserResult, CancellationToken.None).catch(
                (e) => {
                    if (globalSettings.trace.server === 'messages') console.error(e);
                    return null;
                }
            );
            if (!plan) return null;
            if ('failure' in plan) return { inserted: false, failure: plan.failure } as InsertSchemaFieldResult;
            const applied = (await connection.workspace.applyEdit({ changes: { [args.uri]: [plan.edit] } })).applied;
            return {
                inserted: applied,
                field: plan.field,
                failure: applied ? undefined : 'editRejected',
            } as InsertSchemaFieldResult;
        }
    });
}
