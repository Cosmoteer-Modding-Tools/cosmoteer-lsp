import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { join } from 'path';
import { readFileSync } from 'fs';
import { parseText } from '../../../src/utils/ast.utils';
import { filePathToUri } from '../../../src/document/reference-path';
import { buildPartGridData } from '../../../src/features/part-editor/part-grid-data.service';
import { buildPartGridEdit } from '../../../src/features/part-editor/grid-edit.service';
import { CoverageLayerData, GridMutation, PartGridData } from '../../../src/features/part-editor/part-grid.types';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// The weapon coverage layer: the payload reads each weapon's physical limits and its
// DefaultWeaponCoverage through chains and inheritance, and `setCoverage` writes the coverage group
// back in the form the file uses.
const token = CancellationToken.None;
const path = join(FIXTURES_DIR, 'part-editor', 'weapon_part.rules');

/**
 * Builds the payload for a text of the weapon fixture.
 * @param text the part file's text.
 * @returns the payload.
 */
const payloadOf = async (text: string): Promise<PartGridData> =>
    (await buildPartGridData(parseText(text, path), 0, 1, token))!;

/**
 * The coverage layer of one weapon.
 * @param data the payload.
 * @param component the weapon's name.
 * @returns the layer.
 */
const coverageOf = (data: PartGridData, component: string): CoverageLayerData =>
    data.layers.find((layer) => layer.kind === 'coverage' && layer.component === component) as CoverageLayerData;

/**
 * Applies one mutation to the fixture.
 * @param mutation the mutation.
 * @returns the edited text and the payload rebuilt from it.
 */
const mutate = async (mutation: GridMutation): Promise<{ edited: string; data: PartGridData }> => {
    const text = readFileSync(path, 'utf-8');
    const result = await buildPartGridEdit(parseText(text, path), text, path, 0, mutation, token);
    expect(result.status, result.message).toBe('ok');
    const document = TextDocument.create(filePathToUri(path), 'rules', 1, text);
    const edited = TextDocument.applyEdits(document, result.edit!.changes![filePathToUri(path)]);
    return { edited, data: await payloadOf(edited) };
};

beforeAll(async () => {
    await initWorkspace();
});

describe('weapon coverage payload', () => {
    it('reads a turret: location, mount, physical arc and range, and its written coverage', async () => {
        const turret = coverageOf(await payloadOf(readFileSync(path, 'utf-8')), 'Turret');
        expect(turret).toMatchObject({
            id: 'Components/Turret/DefaultWeaponCoverage',
            group: 'Weapons',
            weaponKind: 'turret',
            center: { x: 1, y: 1 },
            mountDeg: -90,
            physicalArcDeg: 120,
            physicalRange: 40,
            coverage: { range: 30, arcNearDeg: -30, arcWidthDeg: 60, restPosition: null },
            allowCoverageEditing: true,
            forceWidthZero: false,
            matchWeaponCoverage: null,
            inherited: false,
        });
    });

    it('reads a chained fixed weapon through its parent transform and its bullet range', async () => {
        const gun = coverageOf(await payloadOf(readFileSync(path, 'utf-8')), 'Gun');
        expect(gun.weaponKind).toBe('fixed');
        expect(gun.center!.x).toBeCloseTo(1);
        expect(gun.center!.y).toBeCloseTo(0.5);
        expect(gun).toMatchObject({ mountDeg: -90, physicalArcDeg: null, physicalRange: 25, origin: null });
    });

    it('reads a weapon built on a template through inheritance', async () => {
        const mirror = coverageOf(await payloadOf(readFileSync(path, 'utf-8')), 'Mirror');
        expect(mirror).toMatchObject({
            center: { x: 0, y: 1 },
            mountDeg: 90,
            physicalArcDeg: 360,
            physicalRange: null,
            coverage: { range: 20, arcNearDeg: 0, arcWidthDeg: 90, restPosition: 0.25 },
            inherited: true,
            matchWeaponCoverage: 'Turret',
        });
    });

    it('reads an arc written in the group form', async () => {
        const cannon = coverageOf(await payloadOf(readFileSync(path, 'utf-8')), 'Cannon');
        expect(cannon.coverage).toEqual({ range: null, arcNearDeg: -10, arcWidthDeg: 20, restPosition: null });
    });
});

describe('setCoverage edits', () => {
    it('inserts a new coverage group in block form', async () => {
        const { edited, data } = await mutate({ op: 'setCoverage', component: 'Gun', field: 'Range', value: 12 });
        expect(edited).toContain(
            '\t\t\tEmitter = GunEmitter\n\t\t\tDefaultWeaponCoverage\n\t\t\t{\n\t\t\t\tRange = 12\n\t\t\t}\n'
        );
        expect(coverageOf(data, 'Gun').coverage.range).toBe(12);
    });

    it('overwrites a written range in place', async () => {
        const { edited, data } = await mutate({ op: 'setCoverage', component: 'Turret', field: 'Range', value: 35 });
        expect(edited).toContain('\t\t\t\tRange = 35\n\t\t\t\tArc = [-30d, 60d]');
        expect(coverageOf(data, 'Turret').coverage.range).toBe(35);
    });

    it('writes an arc in the list form with degree suffixes', async () => {
        const { edited, data } = await mutate({
            op: 'setCoverage',
            component: 'Turret',
            field: 'Arc',
            value: { nearDeg: -20, widthDeg: 40.5 },
        });
        expect(edited).toContain('Arc = [-20d, 40.5d]');
        expect(coverageOf(data, 'Turret').coverage).toMatchObject({ arcNearDeg: -20, arcWidthDeg: 40.5 });
    });

    it('keeps the group form of an arc', async () => {
        const { edited } = await mutate({
            op: 'setCoverage',
            component: 'Cannon',
            field: 'Arc',
            value: { nearDeg: -10, widthDeg: 45 },
        });
        expect(edited).toContain('Arc { NearEdge = -10d; Width = 45d }');
    });

    it('removes one member and keeps the rest of the group', async () => {
        const { edited, data } = await mutate({ op: 'setCoverage', component: 'Turret', field: 'Range', value: null });
        expect(edited).toContain('\t\t\tDefaultWeaponCoverage\n\t\t\t{\n\t\t\t\tArc = [-30d, 60d]\n\t\t\t}');
        expect(coverageOf(data, 'Turret').coverage).toMatchObject({ range: null, arcNearDeg: -30 });
    });

    it('removes the whole group with its last member', async () => {
        const { edited, data } = await mutate({ op: 'setCoverage', component: 'Cannon', field: 'Arc', value: null });
        expect(edited).toContain('\t\t\tFiringArc = 90d\n\t\t}');
        expect(coverageOf(data, 'Cannon').origin).toBeNull();
    });

    it('copies an inherited coverage group down whole with the change applied', async () => {
        const { edited, data } = await mutate({ op: 'setCoverage', component: 'Mirror', field: 'Range', value: 25 });
        expect(edited).toContain(
            '\t\t\tMatchWeaponCoverage = Turret\n\t\t\tDefaultWeaponCoverage\n\t\t\t{\n\t\t\t\tRange = 25\n\t\t\t\tArc = [0d, 90d]\n\t\t\t\tRestPosition = 0.25\n\t\t\t}\n'
        );
        expect(coverageOf(data, 'Mirror')).toMatchObject({
            inherited: false,
            coverage: { range: 25, arcNearDeg: 0, arcWidthDeg: 90, restPosition: 0.25 },
        });
    });

    it('refuses a component that is not a weapon', async () => {
        const text = readFileSync(path, 'utf-8');
        const result = await buildPartGridEdit(
            parseText(text, path),
            text,
            path,
            0,
            { op: 'setCoverage', component: 'TurretEmitter', field: 'Range', value: 5 },
            token
        );
        expect(result.status).toBe('error');
    });

    it('refuses a value that is not a finite number', async () => {
        const text = readFileSync(path, 'utf-8');
        const result = await buildPartGridEdit(
            parseText(text, path),
            text,
            path,
            0,
            { op: 'setCoverage', component: 'Turret', field: 'Arc', value: { nearDeg: Infinity, widthDeg: 10 } },
            token
        );
        expect(result.status).toBe('error');
    });
});
