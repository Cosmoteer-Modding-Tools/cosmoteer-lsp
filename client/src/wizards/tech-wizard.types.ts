/**
 * The payload shapes of the tech wizard: what the server reports after scanning the mod and after
 * writing the tech, and what the form hands back.
 */

export interface NewTechPart {
    id: string;
    name?: string;
    fsPath: string;
    groupField: 'EditorGroup' | 'EditorGroups' | 'none';
}

export interface NewTechEntry {
    id: string;
    name?: string;
}

export interface NewTechScanResult {
    kind: 'scan';
    modRoot: string;
    modId: string;
    parts: NewTechPart[];
    techs: NewTechEntry[];
    takenIds: string[];
    failure?: string;
}

export interface NewTechApplyResult {
    kind: 'apply';
    id: string;
    file: string;
    manifest: string;
    wiring: Record<string, string>;
    manifests?: string[];
    createdFiles: string[];
    changedFiles: string[];
    failure?: string;
}

/** What the form hands back. */
export interface TechForm {
    part: string;
    cost: number;
    prerequisites: string[];
}
