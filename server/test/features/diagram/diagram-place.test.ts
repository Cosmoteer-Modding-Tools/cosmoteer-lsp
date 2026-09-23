import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken } from 'vscode-languageserver';
import { readFileSync } from 'fs';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { buildResourceFlowDiagram } from '../../../src/features/part-editor/resource-flow.diagram';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, WORKSPACE_DATA_DIR } from '../../workspace-helper';
import { FIXTURES_DIR } from '../../helpers';

// Clicking a box opens the file the component is written in. Nearly every part inherits most of its
// components, so a box usually stands for a node in a base file, and taking the file from the part
// being drawn opened that part at a line counted in the base.
const token = CancellationToken.None;
const DIR = join(FIXTURES_DIR, 'diagram-inherited');
const PART_FILE = join(DIR, 'derived_flow_part.rules');
const BASE_FILE = join(DIR, 'base_flow_part.rules');

describe('where a diagram box links to', () => {
    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('opens the base file at the inherited component, and the part file at its own', async () => {
        const document = await parseFilePath(PART_FILE);
        const offset = readFileSync(PART_FILE, 'utf8').indexOf('Drain');
        const diagram = await buildResourceFlowDiagram(document, offset, token);
        expect(diagram).toBeDefined();
        const place = (label: string) => diagram!.nodes.find((node) => node.label === label)?.place;
        // `Ammo` is declared in the base file, on the line its name is written.
        expect(place('Ammo')?.uri).toBe(filePathToUri(BASE_FILE));
        expect(place('Ammo')?.line).toBe(7);
        // `Drain` is the part's own, so it keeps pointing into the part file.
        expect(place('Drain')?.uri).toBe(filePathToUri(PART_FILE));
    });

    it('answers a uri the client can open rather than an on-disk path', async () => {
        const document = await parseFilePath(PART_FILE);
        const offset = readFileSync(PART_FILE, 'utf8').indexOf('Drain');
        const diagram = await buildResourceFlowDiagram(document, offset, token);
        for (const node of diagram!.nodes) {
            if (node.place) expect(node.place.uri.startsWith('file://')).toBe(true);
        }
    });
});
