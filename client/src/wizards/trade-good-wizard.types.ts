/**
 * The payload shapes of the trade good wizard: what the server reports after scanning the resources and
 * after writing the manifest actions, and what the form hands back.
 */

export interface TradeResource {
    id: string;
    name?: string;
    source: 'game' | 'mod';
    stackable: boolean;
    alreadyCarried: boolean;
    alreadyStocked: boolean;
}

export interface TradeGoodScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    resources: TradeResource[];
    failure?: string;
}

export interface TradeGoodApplyResult {
    kind: 'apply';
    resource: string;
    manifest: string;
    wiring: Record<string, string>;
    manifests?: string[];
    changedFiles: string[];
    failure?: string;
}

/** What the form hands back. */
export interface TradeGoodForm {
    resource: string;
    rarity: string;
    stationsBuy: boolean;
}
