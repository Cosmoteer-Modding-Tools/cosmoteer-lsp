/**
 * The shapes the trade-good command speaks in. Both clients ask the same two questions of the
 * server, which resources could be traded from here and what wiring one did, so the shapes live
 * apart from the command that answers them.
 */

import { CancellationToken } from 'vscode-languageserver';
import { NewContentHost } from '../refactor/new-content/new-content.command';
import { WiringOutcome } from './mod-wiring';

/** How common the resource is among what traders carry, on the scale the game's own entries use. */
export type TradeRarity = 'common' | 'uncommon' | 'rare';

/** Why the command wrote nothing. */
export type TradeGoodFailure = 'noModRoot' | 'notEditable' | 'noGameRoot' | 'unknownResource' | 'notStackable';

/** What the client sends. Without a `resource` the command reports what could be traded here. */
export interface TradeGoodArgs {
    /** A file or folder of the mod whose manifest is written. */
    uri: string;
    /** The resource id. Absent on the scan round. */
    resource?: string;
    /** How common it is. Absent, it is uncommon. */
    rarity?: TradeRarity;
    /** True when stations buy it from the player rather than stock it for sale. */
    stationsBuy?: boolean;
}

/** One resource the trade could carry. */
export interface TradeResource {
    id: string;
    /** Its display name, when the language files declare one. */
    name?: string;
    /** Whether the game or a workspace mod declares it. */
    source: 'game' | 'mod';
    /** Whether it stacks, which a resource with no stack size does not, and the trade never carries one that does not. */
    stackable: boolean;
    /** Whether the mod's manifests already put it on trade ships. */
    alreadyCarried: boolean;
    /** Whether the mod's manifests already put it in station stock. */
    alreadyStocked: boolean;
}

/** The server facilities the command needs: the content host, plus the language files for the resource names. */
export interface TradeGoodHost extends NewContentHost {
    /**
     * The display name a localization key resolves to, for the resource picker.
     *
     * @param key the key path.
     * @param cancellationToken cancels the lookup.
     * @returns the text, or undefined when no language file declares the key.
     */
    localizedName?(key: string, cancellationToken: CancellationToken): Promise<string | undefined>;
}

/** What could be traded from this mod. */
export interface TradeGoodScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    /** The resources, the mod's own first, then the game's, each in registry order. */
    resources: TradeResource[];
    failure?: TradeGoodFailure;
}

/** What wiring the resource did. */
export interface TradeGoodApplyResult {
    kind: 'apply';
    resource: string;
    /** The manifest the actions went into, empty when none did. */
    manifest: string;
    /** How each wiring went: the trade ship cargo and the station stock. */
    wiring: Record<'cargo' | 'stations', WiringOutcome>;
    /** The manifest names to choose between, only set when a wiring is `ambiguousManifest`. */
    manifests?: string[];
    changedFiles: string[];
    failure?: TradeGoodFailure;
}

export type TradeGoodResult = TradeGoodScanResult | TradeGoodApplyResult;
