import { describe, expect, it } from 'vitest';
import { evaluateFormula } from '../../../src/features/part-table/part-table.formula';
import { PartTableRow } from '../../../src/features/part-table/part-table.types';

const cell = (value: number | null) => ({
    text: String(value),
    value,
    uri: 'file:///parts.rules',
    line: 0,
    character: 0,
    inherited: false,
});

const row = (key: string, cells: Record<string, number | null>): PartTableRow => ({
    key,
    id: key,
    name: key,
    file: 'parts.rules',
    uri: 'file:///parts.rules',
    line: 0,
    character: 0,
    origin: 'game',
    source: 'Cosmoteer',
    categories: [],
    components: [],
    editorGroup: '',
    editorGroups: [],
    ships: [],
    cells: Object.fromEntries(Object.entries(cells).map(([path, value]) => [path, cell(value)])),
});

const rows = [
    row('small', { MaxHealth: 6000, 'StatsByCategory/0/Stats/ShieldHP': 15000, Cost: 5000 }),
    row('large', { MaxHealth: 12000, 'StatsByCategory/0/Stats/ShieldHP': 45000, Cost: 20000 }),
    row('broken', { MaxHealth: 1000, Cost: 0 }),
];

describe('part table formula columns', () => {
    it('computes arithmetic over the columns of each row', () => {
        const result = evaluateFormula('[MaxHealth] / [Cost]', rows, undefined);
        expect(result.error).toBeUndefined();
        expect(result.values.small).toBeCloseTo(1.2, 10);
        expect(result.values.large).toBeCloseTo(0.6, 10);
    });

    it('reads a single-segment column written without brackets', () => {
        expect(evaluateFormula('MaxHealth * 2', rows, undefined).values.small).toBe(12000);
    });

    it('answers with nothing where a division has no answer', () => {
        expect(evaluateFormula('[MaxHealth] / [Cost]', rows, undefined).values.broken).toBeNull();
    });

    it('answers with nothing where a row has no value in a column', () => {
        const result = evaluateFormula('[StatsByCategory/0/Stats/ShieldHP] + 1', rows, undefined);
        expect(result.values.small).toBe(15001);
        expect(result.values.broken).toBeNull();
    });

    it('compares a row against the reference row', () => {
        const result = evaluateFormula('[Cost] / ref([Cost]) * 100', rows, rows[0]);
        expect(result.values.small).toBe(100);
        expect(result.values.large).toBe(400);
    });

    it('picks a branch with a conditional', () => {
        const result = evaluateFormula('if([Cost] > 10000, 1, 0)', rows, undefined);
        expect(result.values.small).toBe(0);
        expect(result.values.large).toBe(1);
    });

    it('takes the functions of the rules math, with the same meaning', () => {
        expect(evaluateFormula('max([MaxHealth], [Cost])', rows, undefined).values.small).toBe(6000);
        expect(evaluateFormula('round([MaxHealth] / [Cost], 2)', rows, undefined).values.small).toBe(1.2);
        expect(evaluateFormula('sum(1, 2, 3)', rows, undefined).values.small).toBe(6);
    });

    it('reports a formula it cannot read instead of computing a wrong column', () => {
        expect(evaluateFormula('[MaxHealth] +', rows, undefined).error).toBeTruthy();
        expect(evaluateFormula('nonsense([MaxHealth])', rows, undefined).error).toBeTruthy();
        expect(evaluateFormula('[MaxHealth', rows, undefined).error).toBeTruthy();
    });
});

const parts = [
    row('laser', {
        MaxHealth: 6000,
        'Resources/Steel': 10,
        'Resources/Copper': 5,
        'StatsByCategory/0/Stats/DamagePerSecond/Hull': 30,
        'StatsByCategory/1/Stats/DamagePerSecond/Shield': 70,
    }),
    row('cannon', { MaxHealth: 12000, 'Resources/Steel': 20, 'StatsByCategory/0/Stats/DamagePerSecond/Hull': 50 }),
    row('armor', { MaxHealth: 12000, 'Resources/Steel': 4 }),
    row('hull', { MaxHealth: 1000 }),
];

describe('part table formula columns with the view state', () => {
    it('reads a value the reader typed over a cell ahead of the file', () => {
        const overrides = { laser: { maxhealth: 100 } };
        const result = evaluateFormula('[MaxHealth] * 2', parts, undefined, { overrides });
        expect(result.values.laser).toBe(200);
        expect(result.values.cannon).toBe(24000);
    });

    it('answers with nothing where the typed value is no number', () => {
        const overrides = { laser: { MaxHealth: null } };
        expect(evaluateFormula('[MaxHealth]', parts, undefined, { overrides }).values.laser).toBeNull();
    });

    it('reads another formula column by its name', () => {
        const formulas = { Steel: '[Resources/Steel] * 100' };
        expect(evaluateFormula('[steel] + 1', parts, undefined, { formulas }).values.laser).toBe(1001);
        expect(evaluateFormula('Steel + 1', parts, undefined, { formulas }).values.cannon).toBe(2001);
    });

    it('prefers a column of the row over a formula of the same name', () => {
        const formulas = { MaxHealth: '1' };
        expect(evaluateFormula('[MaxHealth]', parts, undefined, { formulas }).values.laser).toBe(6000);
    });

    it('answers with nothing where formula columns name each other in a circle', () => {
        const formulas = { A: '[B] + 1', B: '[A] + 1' };
        const result = evaluateFormula('[A]', parts, undefined, { formulas });
        expect(result.error).toBeUndefined();
        expect(result.values.laser).toBeNull();
    });

    it('answers with nothing for a formula column that cannot be read', () => {
        const formulas = { Broken: '[MaxHealth] +' };
        const result = evaluateFormula('coalesce([Broken], 7)', parts, undefined, { formulas });
        expect(result.error).toBeUndefined();
        expect(result.values.laser).toBe(7);
    });

    it('spreads a glob into the arguments of a call', () => {
        expect(evaluateFormula('sum([Resources/*])', parts, undefined).values.laser).toBe(15);
        expect(evaluateFormula('sum([resources/*])', parts, undefined).values.cannon).toBe(20);
        const deep = evaluateFormula('max([StatsByCategory/*/Stats/DamagePerSecond/*])', parts, undefined);
        expect(deep.values.laser).toBe(70);
        expect(deep.values.cannon).toBe(50);
        expect(deep.values.armor).toBeNull();
    });

    it('sums the columns a glob matches where it stands for one value', () => {
        const result = evaluateFormula('[Resources/*] / 5', parts, undefined);
        expect(result.values.laser).toBe(3);
        expect(result.values.hull).toBeNull();
    });

    it('lets a single star stop at a separator and a double star cross it', () => {
        expect(evaluateFormula('[StatsByCategory/*]', parts, undefined).values.laser).toBeNull();
        expect(evaluateFormula('[StatsByCategory/**]', parts, undefined).values.laser).toBe(100);
        expect(evaluateFormula('[**/Hull]', parts, undefined).values.laser).toBe(30);
    });

    it('reads typed values through a glob in place of the file values they cover', () => {
        const overrides = { laser: { 'resources/steel': 1 } };
        expect(evaluateFormula('sum([Resources/*])', parts, undefined, { overrides }).values.laser).toBe(6);
    });

    it('takes the reference row through a glob', () => {
        const result = evaluateFormula('[Resources/*] / ref([Resources/*])', parts, parts[0]);
        expect(result.values.laser).toBe(1);
        expect(result.values.armor).toBeCloseTo(4 / 15, 10);
    });

    it('falls back to the first present value with coalesce', () => {
        expect(evaluateFormula('coalesce([Resources/Copper], [Resources/Steel], 0)', parts, undefined).values).toEqual({
            laser: 5,
            cannon: 20,
            armor: 4,
            hull: 0,
        });
        expect(evaluateFormula('coalesce([Nothing], [Resources/Copper])', parts, undefined).values.hull).toBeNull();
    });

    it('tells whether a row has a value with has', () => {
        const result = evaluateFormula('has([Resources/Copper])', parts, undefined);
        expect(result.values.laser).toBe(1);
        expect(result.values.cannon).toBe(0);
        expect(evaluateFormula('has([Resources/*])', parts, undefined).values.hull).toBe(0);
        const guarded = evaluateFormula('if(has([Resources/Copper]), [Resources/Copper], 0)', parts, undefined);
        expect(guarded.values.cannon).toBe(0);
    });

    it('aggregates a column over the rows, skipping the rows without a value', () => {
        const column = (formula: string) => evaluateFormula(formula, parts, undefined).values.hull;
        expect(column('colmin([Resources/Steel])')).toBe(4);
        expect(column('colmax([Resources/Steel])')).toBe(20);
        expect(column('colsum([Resources/Steel])')).toBe(34);
        expect(column('colavg([Resources/Steel])')).toBeCloseTo(34 / 3, 10);
        expect(column('colcount([Resources/Steel])')).toBe(3);
        expect(column('colmedian([Resources/Steel])')).toBe(10);
        expect(column('colmedian([MaxHealth])')).toBe(9000);
        expect(column('colmax([Nothing])')).toBeNull();
    });

    it('aggregates an expression rather than only a column', () => {
        const result = evaluateFormula('[MaxHealth] / colmax([MaxHealth] * 2)', parts, undefined);
        expect(result.values.cannon).toBe(0.5);
    });

    it('ranks the rows by a value, letting equal values share a rank', () => {
        const result = evaluateFormula('rank([MaxHealth])', parts, undefined);
        expect(result.values).toEqual({ cannon: 1, armor: 1, laser: 3, hull: 4 });
        expect(evaluateFormula('rank([Resources/Copper])', parts, undefined).values.cannon).toBeNull();
    });

    it('runs the aggregates over the rows on screen only', () => {
        const visible = ['laser', 'armor'];
        const result = evaluateFormula('colmax([MaxHealth])', parts, undefined, { visible });
        expect(result.values.laser).toBe(12000);
        expect(result.values.cannon).toBe(12000);
        const ranked = evaluateFormula('rank([MaxHealth])', parts, undefined, { visible });
        expect(ranked.values.laser).toBe(2);
        expect(ranked.values.hull).toBe(3);
    });
});
