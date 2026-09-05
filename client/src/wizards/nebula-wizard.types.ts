/**
 * The payload shapes of the nebula wizard: what the server reports after scanning the mod and after
 * writing the nebula, and what the form hands back.
 */

export type Rgb = [number, number, number];

export interface NebulaBase {
    id: string;
    colors: [Rgb, Rgb, Rgb];
}

export interface NewNebulaScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    takenIds: string[];
    bases: NebulaBase[];
    failure?: string;
}

export interface NewNebulaApplyResult {
    kind: 'apply';
    id: string;
    nebulaFile: string;
    spawnerFile: string;
    doodadFile: string;
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
export interface NebulaForm {
    id: string;
    name: string;
    base: string;
    colors: [Rgb, Rgb, Rgb];
    radius: number;
    count: [number, number];
    distance: [number, number];
    spawnChance: number;
    avoidStartingSector: boolean;
}
