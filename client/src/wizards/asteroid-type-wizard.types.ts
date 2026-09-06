/**
 * The payload shapes of the asteroid type wizard: what the server reports after scanning the mod and after
 * writing the asteroid type, and what the form hands back.
 */

export type AsteroidSize = 's' | 'm' | 'l' | 'xl' | 'xxl';
export type AsteroidRarity = 'common' | 'rare' | 'sun';

export interface AsteroidResource {
    id: string;
    name?: string;
}

export interface AsteroidLook {
    id: string;
    label: string;
}

export interface NewAsteroidTypeScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    resources: AsteroidResource[];
    looks: AsteroidLook[];
    takenIds: string[];
    authorPrefix: string;
    failure?: string;
}

export interface NewAsteroidTypeApplyResult {
    kind: 'apply';
    id: string;
    folder: string;
    files: string[];
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
export interface AsteroidTypeForm {
    id: string;
    name: string;
    resource: string;
    look: string;
    rarity: AsteroidRarity;
    sizes: AsteroidSize[];
    weight: number;
    hard: boolean;
    density?: number;
}
