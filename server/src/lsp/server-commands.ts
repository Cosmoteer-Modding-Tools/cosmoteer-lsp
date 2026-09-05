import { OPEN_IN_DECOMPILER_COMMAND } from '../features/hover/decompiler-link';
import { MIGRATE_WORKSPACE_COMMAND } from '../features/migration/migrate-workspace';
import { MIGRATE_SYMBOL_COMMAND } from '../features/migration/migrate-symbol';
import { BUILD_MOD_SCHEMA_COMMAND } from '../features/mod-schema/mod-schema';
import { EXTRACT_SHARED_BASE_COMMAND } from '../features/refactor/shared-base/shared-base.command';
import { EXTRACT_LOCALIZATION_KEY_COMMAND } from '../features/refactor/extract-localization-key';
import { REGISTER_PART_IN_SHIP_COMMAND } from '../features/refactor/register-part/register-part.command';
import { CREATE_COMPONENT_COMMAND } from '../features/refactor/create-component/create-component.command';
import { EXTRACT_GROUP_COMMAND } from '../features/refactor/extract-group/extract-group.command';
import { OVERRIDE_IN_MOD_COMMAND } from '../features/refactor/override-in-mod/override-in-mod.command';
import { CLONE_DECLARATION_COMMAND } from '../features/refactor/clone-declaration/clone.command';
import { INSERT_SCHEMA_FIELD_COMMAND } from '../features/schema-search/schema-search.insert';
import { RUN_IN_COSMOTEER_COMMAND } from '../features/run-game/run-game.command';
import { IMPORT_GAME_LOG_COMMAND } from '../features/game-log/import-game-log.command';
import { NEW_CONTENT_COMMAND } from '../features/refactor/new-content/new-content.command';
import { NEW_MOD_COMMAND } from '../features/refactor/new-mod/new-mod.command';
import { REGISTER_SHIP_COMMAND } from '../features/ships/register-ship.command';
import { NEW_FACTION_COMMAND } from '../features/ships/new-faction.command';
import { NEW_NEBULA_COMMAND } from '../features/ships/new-nebula.command';
import { NEW_GALAXY_SIZE_COMMAND } from '../features/ships/new-galaxy-size.command';
import { NEW_ASTEROID_TYPE_COMMAND } from '../features/ships/new-asteroid-type.command';
import { NEW_PLANET_COMMAND } from '../features/ships/new-planet.command';
import { TRADE_GOOD_COMMAND } from '../features/ships/trade-good.command';
import { NEW_TECH_COMMAND } from '../features/ships/new-tech.command';

/**
 * Every command the server executes, which is what it declares in `executeCommandProvider`.
 *
 * The list lives here rather than inline in the capabilities so a test can read it. The language
 * client registers an editor command for each of these ids, so one that collides with a command a
 * client registers itself throws while the client is initializing and takes the whole server down
 * with it. Nothing about that failure points at the collision, so the tripwire is worth the module.
 */
export const SERVER_COMMANDS: readonly string[] = [
    OPEN_IN_DECOMPILER_COMMAND,
    MIGRATE_WORKSPACE_COMMAND,
    MIGRATE_SYMBOL_COMMAND,
    BUILD_MOD_SCHEMA_COMMAND,
    EXTRACT_SHARED_BASE_COMMAND,
    EXTRACT_LOCALIZATION_KEY_COMMAND,
    REGISTER_PART_IN_SHIP_COMMAND,
    CREATE_COMPONENT_COMMAND,
    EXTRACT_GROUP_COMMAND,
    OVERRIDE_IN_MOD_COMMAND,
    CLONE_DECLARATION_COMMAND,
    INSERT_SCHEMA_FIELD_COMMAND,
    RUN_IN_COSMOTEER_COMMAND,
    IMPORT_GAME_LOG_COMMAND,
    NEW_CONTENT_COMMAND,
    NEW_MOD_COMMAND,
    REGISTER_SHIP_COMMAND,
    NEW_FACTION_COMMAND,
    NEW_NEBULA_COMMAND,
    NEW_GALAXY_SIZE_COMMAND,
    NEW_ASTEROID_TYPE_COMMAND,
    NEW_PLANET_COMMAND,
    TRADE_GOOD_COMMAND,
    NEW_TECH_COMMAND,
];
