import { describe, expect, it } from 'vitest';
import { DocumentSymbol, SymbolKind } from 'vscode-languageserver';
import { DocumentSymbolService } from '../../../src/features/navigation/document-symbol.service';
import { parseFixture } from '../../helpers';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

const service = DocumentSymbolService.instance;

const byName = (symbols: DocumentSymbol[], name: string): DocumentSymbol => {
    const found = symbols.find((s) => s.name === name);
    if (!found) throw new Error(`No symbol named "${name}" in [${symbols.map((s) => s.name).join(', ')}]`);
    return found;
};

/** True when (line, char) is at or before (oLine, oChar). */
const atOrBefore = (line: number, char: number, oLine: number, oChar: number): boolean =>
    line < oLine || (line === oLine && char <= oChar);

/**
 * selectionRange must sit within range, an LSP invariant the editor relies on. The client
 * swap-normalizes any reversed range before checking containment, so mirror that here (char-level,
 * not just line-level) to catch the malformed-input case the editor would actually reject.
 */
const assertSelectionWithinRange = (symbol: DocumentSymbol): void => {
    const order = (r: DocumentSymbol['range']) =>
        atOrBefore(r.start.line, r.start.character, r.end.line, r.end.character) ? r : { start: r.end, end: r.start };
    const range = order(symbol.range);
    const sel = order(symbol.selectionRange);
    expect(atOrBefore(range.start.line, range.start.character, sel.start.line, sel.start.character)).toBe(true);
    expect(atOrBefore(sel.end.line, sel.end.character, range.end.line, range.end.character)).toBe(true);
    symbol.children?.forEach(assertSelectionWithinRange);
};

describe('DocumentSymbolService — outline', () => {
    it('annotates typed groups with their resolved schema class in the detail', () => {
        const src = 'Part\n{\n\tComponents\n\t{\n\t\tTurret\n\t\t{\n\t\t\tType = TurretWeapon\n\t\t}\n\t}\n}';
        const doc = parser(lexer(src), 'file:///t.rules').value;
        const symbols = service.getDocumentSymbols(doc);
        const part = byName(symbols, 'Part');
        expect(part.detail).toContain('PartRules');
        const components = byName(part.children!, 'Components');
        const turret = byName(components.children!, 'Turret');
        expect(turret.detail).toContain('TurretWeaponRules');
    });

    it('emits one top-level symbol per group and nests its members', () => {
        const doc = parseFixture('inheritance.rules');
        const symbols = service.getDocumentSymbols(doc);

        expect(symbols.map((s) => s.name)).toEqual([
            'SW_Ion_Thruster_Overdrive',
            'SW_Ion_Thruster_Overdrive_Thrust',
            'SW_Ion_Thruster_Boost',
            'SW_Ion_Thruster_Boost_RampUp',
        ]);

        const overdrive = byName(symbols, 'SW_Ion_Thruster_Overdrive');
        expect(overdrive.kind).toBe(SymbolKind.Object);
        expect(overdrive.children?.map((c) => c.name)).toEqual(['CombineMode', 'BaseValue']);
    });

    it('surfaces inheritance as the symbol detail', () => {
        const doc = parseFixture('inheritance.rules');
        const symbols = service.getDocumentSymbols(doc);

        expect(byName(symbols, 'SW_Ion_Thruster_Overdrive_Thrust').detail).toBe(': SW_Ion_Thruster_Overdrive');
        expect(byName(symbols, 'SW_Ion_Thruster_Boost_RampUp').children?.map((c) => c.name)).toEqual(['Exponent']);
    });

    it('folds `key = { … }` into a single container and recurses deep nesting', () => {
        const doc = parseFixture('colors.rules');
        const symbols = service.getDocumentSymbols(doc);

        // `_Black = [ … ]` is one Array symbol whose children are the positional entries.
        const black = byName(symbols, '_Black');
        expect(black.kind).toBe(SymbolKind.Array);
        expect(black.children?.map((c) => c.name)).toEqual(['[0]', '[1]', '[2]', '[3]']);

        // Black { RGBA, RGB, Float { Rf … Af } } — nested group reached two levels down.
        const float = byName(byName(symbols, 'Black').children!, 'Float');
        expect(float.kind).toBe(SymbolKind.Object);
        expect(float.children?.map((c) => c.name)).toEqual(['Rf', 'Gf', 'Bf', 'Af']);
    });

    it('keeps selectionRange within range for every symbol', () => {
        service.getDocumentSymbols(parseFixture('colors.rules')).forEach(assertSelectionWithinRange);
    });

    it('keeps selectionRange within range even when a stray `[` malforms a container', () => {
        // A stray `[` right before a group (`[{ … }`) leaves the recovered group's end column at
        // its `0` default while its start column is `1`, producing a reversed one-line range whose
        // true start escaped the union. The editor then rejected the whole outline with
        // "selectionRange must be contained in fullRange".
        const src = 'Part\n[{\n\tResources\n\t[\n\t\t[steel, 84]\n\t]\n}';
        const doc = parser(lexer(src), 'file:///t.rules').value;
        service.getDocumentSymbols(doc).forEach(assertSelectionWithinRange);
    });
});
