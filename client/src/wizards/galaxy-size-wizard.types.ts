/**
 * The payload shapes of the galaxy size wizard: what the server reports after scanning the mod and after
 * writing the galaxy size, and what the form hands back.
 */

export interface NewGalaxySizeScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    takenIds: string[];
    standardSystems: number;
    failure?: string;
}

export interface NewGalaxySizeApplyResult {
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
export interface GalaxySizeForm {
    id: string;
    name: string;
    systems: number;
}
