/**
 * The shapes the built-in ships emitter writes from: how a role is laid out, where a faction's and
 * a role's files sit under a mod, what one ship entry and one trade-route entry say, and where an
 * insertion into an existing file goes. The emitter turns them into text and the register-ship
 * command fills them in, so they live apart from both.
 */

import { ShipDifficulty, ShipRole } from './ship-assessment.types';

/** The line ending a generated file is written with. */
export type LineEnding = '\n' | '\r\n';

/** How one role is laid out and tagged. */
export interface RoleLayout {
    /** The folder under the faction's folder. */
    readonly folder: string;
    /** The suffix of the role file's name, `builtins_<faction>_<suffix>.rules`. */
    readonly fileSuffix: string;
    /** The tag the role file gives every ship in it, or undefined for a file that tags nothing. */
    readonly fileTag: string | undefined;
    /** The tags each ship entry adds to the file's. */
    readonly entryTags: readonly string[];
    /** Whether the role file names the faction. Wreckage and starter ships belong to none. */
    readonly faction: boolean;
    /**
     * What the role file prefixes its ships' ids with: the faction, the way the vanilla defense files
     * do, the word Wreckage, the way the vanilla wreckage file does, or nothing.
     */
    readonly prefix: 'faction' | 'wreckage' | undefined;
    /** Whether the ship entry writes a tier. Wreckage and starter ships are not spawned by tier. */
    readonly tiered: boolean;
    /** Whether the ship entry writes a difficulty. The civilian roles write none. */
    readonly difficulty: boolean;
    /** Whether the ship also needs a trade-route entry in the career mode's `TradeShips`. */
    readonly tradeShip: boolean;
}

/** Where a faction's files sit under a mod. */
export interface FactionPaths {
    /** The faction's folder, `<mod>/builtin_ships/<faction>`. */
    readonly folder: string;
    /** The file concatenating the role files, `<folder>/builtins_<faction>.rules`. */
    readonly aggregator: string;
}

/** Where a role's files sit under a faction. */
export interface RolePaths {
    /** The role's folder, `<faction>/<Role>`. */
    readonly folder: string;
    /** The role file, `<folder>/builtins_<faction>_<role>.rules`. */
    readonly file: string;
    /** The trade-route file beside the role file, only for a role that writes one. */
    readonly tradeShips?: string;
}

/** What one ship entry says. */
export interface ShipEntry {
    /** The `File` value, relative to the role file, forward slashes. */
    readonly file: string;
    readonly tier: number;
    readonly difficulty: ShipDifficulty;
    readonly role: ShipRole;
    /** The `StasisIcon` value, relative to the role file, for a station with a rendered icon. */
    readonly stasisIcon?: string;
}

/** Where an insertion into a file goes and what is written there. */
export interface Insertion {
    readonly offset: number;
    readonly text: string;
}

/** What a trade-route entry says. */
export interface TradeShipEntry {
    /** The entry's own name in the `TradeShips` group, unique across the game. */
    readonly name: string;
    /** The built-in ship's id, which for a civilian ship is its name. */
    readonly shipId: string;
    readonly factionId: string;
    readonly tierRange: readonly [number, number];
    readonly stasisSpeed: number;
    readonly stasisTradeTime: number;
}
