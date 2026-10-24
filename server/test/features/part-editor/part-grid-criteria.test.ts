import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { join } from 'path';
import { parseText } from '../../../src/utils/ast.utils';
import { buildPartGridData } from '../../../src/features/part-editor/part-grid-data.service';
import { CriteriaLayerData, PartGridData } from '../../../src/features/part-editor/part-grid.types';
import { FIXTURES_DIR } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// The neighbor criteria layer, modelled on a 4 wide deck railgun. Every edge is written in each
// spelling the game reads a `Range<int>` from: one number, `[min, max]`, and `{ Min; Max }`.
const token = CancellationToken.None;
const partPath = join(FIXTURES_DIR, 'part-editor', 'criteria_part.rules');

const PART = [
    'Part',
    '{',
    '\tSize = [4, 5]',
    '\tComponents',
    '\t{',
    '\t\tReverseOperationBuffProvider',
    '\t\t{',
    '\t\t\tType = AreaBuffProvider',
    '\t\t\tBuffType = RailgunReverseOperation',
    '\t\t\tBuffArea = [1, 5, 2, 1]',
    '\t\t\tCriteria',
    '\t\t\t{',
    '\t\t\t\tRot = 0',
    '\t\t\t\tLeft = 1',
    '\t\t\t\tRight = 3',
    '\t\t\t\tTop = 5',
    '\t\t\t}',
    '\t\t}',
    '\t\tWideProvider',
    '\t\t{',
    '\t\t\tType = AreaBuffProvider',
    '\t\t\tBuffType = RailgunOperation',
    '\t\t\tBuffArea = [0, 5, 4, 1]',
    '\t\t\tCriterias',
    '\t\t\t[',
    '\t\t\t\t{ Left = [0, 2]; Right = { Min = 2; Max = 4 }; Top = 5; FlipX = true }',
    '\t\t\t\t{ Left = -1; Bottom = 0; IDs = [cosmoteer.railgun_accelerator]; ExcludeCategory = armor }',
    '\t\t\t]',
    '\t\t}',
    '\t\tAmmoProxy',
    '\t\t{',
    '\t\t\tType = ResourceStorageProxy',
    '\t\t\tResourceType = bullet',
    '\t\t\tPartLocation = [1, 5]',
    '\t\t\tPartCriteria',
    '\t\t\t{',
    '\t\t\t\tCategory = railgun_ammo',
    '\t\t\t\tLeft = 1',
    '\t\t\t\tRight = 3',
    '\t\t\t}',
    '\t\t\tComponentID = LoadedAmmo',
    '\t\t}',
    '\t}',
    '}',
].join('\n');

const criteriaOf = (data: PartGridData, component: string): CriteriaLayerData => {
    const layer = data.layers.find((candidate) => candidate.id === `Components/${component}/Criteria`);
    expect(layer, component).toBeTruthy();
    return layer as CriteriaLayerData;
};

describe('criteria layer', () => {
    let data: PartGridData;

    beforeAll(async () => {
        await initWorkspace();
        data = (await buildPartGridData(parseText(PART, partPath), 0, 1, token))!;
    });

    it('reads single numbers as one-value ranges', () => {
        const [entry] = criteriaOf(data, 'ReverseOperationBuffProvider').entries;
        expect(entry).toMatchObject({
            left: { min: 1, max: 1 },
            right: { min: 3, max: 3 },
            top: { min: 5, max: 5 },
            bottom: null,
            rot: 0,
            flipX: null,
        });
    });

    it('reads list and group ranges, negatives, flip and filters from a Criterias list', () => {
        const [ranges, filtered] = criteriaOf(data, 'WideProvider').entries;
        expect(ranges).toMatchObject({
            left: { min: 0, max: 2 },
            right: { min: 2, max: 4 },
            top: { min: 5, max: 5 },
            flipX: true,
        });
        expect(filtered).toMatchObject({ left: { min: -1, max: -1 }, bottom: { min: 0, max: 0 }, right: null });
        expect(filtered.filters).toEqual(['cosmoteer.railgun_accelerator', '!armor']);
    });

    it('reads the flat PartCriteria of a proxy', () => {
        const [entry] = criteriaOf(data, 'AmmoProxy').entries;
        expect(entry.filters).toEqual(['railgun_ammo']);
        expect(entry).toMatchObject({ left: { min: 1, max: 1 }, right: { min: 3, max: 3 } });
    });

    it('builds no criteria layer for a component without criteria', async () => {
        const plain = PART.replace(/\t\t\tCriteria\n\t\t\t\{[^}]*\}\n/, '');
        const without = (await buildPartGridData(parseText(plain, partPath), 0, 1, token))!;
        expect(without.layers.some((layer) => layer.id === 'Components/ReverseOperationBuffProvider/Criteria')).toBe(
            false
        );
    });
});
