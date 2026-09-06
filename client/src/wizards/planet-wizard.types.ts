/**
 * The payload shapes of the planet wizard: what the server reports after scanning the mod and after
 * writing the planet, and what the form hands back.
 */

export interface PlanetBase {
    id: string;
    style: string;
    label?: string;
    icon: string;
}

export interface NewPlanetScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    authorPrefix: string;
    takenIds: string[];
    bases: PlanetBase[];
    placements: string[];
    failure?: string;
}

export interface NewPlanetApplyResult {
    kind: 'apply';
    id: string;
    file: string;
    manifest: string;
    wiring: Record<string, string>;
    manifests?: string[];
    localizationKeys: string[];
    localizationFiles: string[];
    createdFiles: string[];
    changedFiles: string[];
    failure?: string;
}

/** What the form hands back. */
export interface PlanetForm {
    id: string;
    name: string;
    base: string;
    placement: string;
    weight: number;
    scale?: [number, number];
    defaultScale?: number;
}
