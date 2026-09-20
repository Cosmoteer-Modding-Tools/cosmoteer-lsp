import { describe, expect, it } from 'vitest';
import { ExcelFormulaContext, toExcelFormula } from '../../../src/features/part-table/part-table.excel-formula';

const context: ExcelFormulaContext = {
    table: 'Parts',
    columns: [
        { path: 'id', name: 'Part', blank: false },
        { path: 'MaxHealth', name: 'MaxHealth', blank: false },
        { path: '@Tiles', name: 'Tiles', blank: false },
        { path: '@Cost', name: 'Cost', blank: true },
        { path: 'Resources/steel', name: 'Resources › steel', blank: true },
        { path: 'Resources/coil', name: 'Resources › coil', blank: true },
        { path: 'Health per tile', name: 'Health per tile', blank: false },
    ],
    idColumn: 'Part',
    referenceId: 'cannon_deck',
};

const excel = (formula: string, over: Partial<ExcelFormulaContext> = {}): string => {
    const result = toExcelFormula(formula, { ...context, ...over });
    if ('reason' in result) throw new Error(result.reason);
    return result.formula;
};

const refused = (formula: string, over: Partial<ExcelFormulaContext> = {}): string => {
    const result = toExcelFormula(formula, { ...context, ...over });
    if ('formula' in result) throw new Error(`translated to ${result.formula}`);
    return result.reason;
};

describe('the part table formula as Excel', () => {
    it('writes a column as a structured reference to the row it sits on', () => {
        expect(excel('[MaxHealth] / [@Tiles]')).toBe('(Parts[[#This Row],[MaxHealth]]/Parts[[#This Row],[Tiles]])');
    });

    it('reads an empty cell as no value rather than as the zero Excel would read', () => {
        expect(excel('[@Cost]')).toBe('IF(Parts[[#This Row],[Cost]]="",NA(),Parts[[#This Row],[Cost]])');
    });

    it('names another formula column of the view by its name', () => {
        expect(excel('[Health per tile] * 2')).toBe('(Parts[[#This Row],[Health per tile]]*2)');
    });

    it('adds up every column a wildcard matches', () => {
        expect(excel('sum([Resources/*])')).toBe(
            'SUM(Parts[[#This Row],[Resources › steel]],Parts[[#This Row],[Resources › coil]])'
        );
    });

    it('reads the compared part through a lookup on the part column', () => {
        expect(excel('[MaxHealth] / ref([MaxHealth])')).toBe(
            '(Parts[[#This Row],[MaxHealth]]/INDEX(Parts[MaxHealth],MATCH("cannon_deck",Parts[Part],0)))'
        );
    });

    it('folds a column aggregate over the whole column', () => {
        expect(excel('colavg([MaxHealth])')).toBe('AVERAGE(Parts[MaxHealth])');
    });

    it('ranks against the whole column, the highest first', () => {
        expect(excel('rank([MaxHealth])')).toBe('RANK(Parts[[#This Row],[MaxHealth]],Parts[MaxHealth])');
    });

    it('writes a condition as the number the view computes', () => {
        expect(excel('if([MaxHealth] > 10000, 1, 0)')).toBe('IF(Parts[[#This Row],[MaxHealth]]>10000,1,0)');
    });

    it('falls back through a coalesce the way the evaluator does', () => {
        expect(excel('coalesce([@Cost], 0)')).toBe(
            'IFERROR(IF(Parts[[#This Row],[Cost]]="",NA(),Parts[[#This Row],[Cost]]),IFERROR(0,NA()))'
        );
    });

    it('answers whether a value is there at all', () => {
        expect(excel('has([@Cost])')).toBe(
            'IF(ISNA(IF(Parts[[#This Row],[Cost]]="",NA(),Parts[[#This Row],[Cost]])),0,1)'
        );
    });

    it('rounds and takes roots the way the game does', () => {
        expect(excel('round(sqrt([MaxHealth]), 1)')).toBe('ROUND(SQRT(Parts[[#This Row],[MaxHealth]]),1)');
    });

    it('writes the remainder out rather than calling Excel, whose sign differs', () => {
        expect(excel('[MaxHealth] % 3')).toBe(
            '(Parts[[#This Row],[MaxHealth]]-3*TRUNC(Parts[[#This Row],[MaxHealth]]/3))'
        );
    });

    it('picks the first value a wildcard has, not the first cell that is empty', () => {
        // Excel reads an empty cell as a zero, which a fallback would pick over the value beside it.
        expect(excel('coalesce([Resources/*], 0)')).toBe(
            'IFERROR(IF(Parts[[#This Row],[Resources › steel]]="",NA(),Parts[[#This Row],[Resources › steel]]),' +
                'IFERROR(IF(Parts[[#This Row],[Resources › coil]]="",NA(),Parts[[#This Row],[Resources › coil]]),' +
                'IFERROR(0,NA())))'
        );
    });

    it('answers nothing where no column a wildcard matches has a value', () => {
        expect(excel('[Resources/*] * 2')).toContain('IF(COUNT(');
    });

    it('reads the compared part through the same guard as the row', () => {
        expect(excel('ref([@Cost])')).toBe(
            'IF(INDEX(Parts[Cost],MATCH("cannon_deck",Parts[Part],0))="",NA(),' +
                'INDEX(Parts[Cost],MATCH("cannon_deck",Parts[Part],0)))'
        );
    });

    it('refuses a wildcard inside a column aggregate, which folds a different set of numbers', () => {
        // The view sums the matched columns per row and folds those sums. Excel has no whole-column
        // form of that sum, and folding every matched cell is another number.
        expect(refused('colmax([Resources/*])')).toContain('wildcard');
        expect(refused('rank([Resources/*])')).toContain('wildcard');
    });

    it('refuses a formula that grows past what Excel holds', () => {
        const nested = new Array(40).fill('[Resources/steel] % [Resources/coil]').join(' + ');
        expect(refused(nested)).toContain('length');
    });

    it('refuses a column that is not in the export', () => {
        expect(refused('[Nowhere]')).toContain('Nowhere');
    });

    it('refuses a comparison against a part when the view compares nothing', () => {
        expect(refused('ref([MaxHealth])', { referenceId: undefined })).toContain('compared');
    });

    it('refuses a formula that does not parse', () => {
        expect(refused('[MaxHealth] +')).toContain('ends');
    });
});
