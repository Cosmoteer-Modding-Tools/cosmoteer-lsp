import { describe, expect, it } from 'vitest';
import { DocumentSymbol } from 'vscode-languageserver';
import { getDocumentSymbols } from '../../../src/features/navigation/document-symbol.service';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';

// A value carried on by a trailing backslash is one value over two lines. Its position records one
// line and a column counted over the whole run, so the outline used to claim the value ended on its
// first line at a column that line does not have. A client reads a symbol's range to decide which
// symbol the caret is in, so the continuation line belonged to no field at all.
const SOURCE = [
    'Strings',
    '{',
    '\tCont = "one " \\',
    '\t       "two"',
    '\tPlain = "x"',
    '\tLayers',
    '\t[',
    '\t\t{',
    '\t\t\tName = "a"',
    '\t\t}',
    '\t]',
    '}',
].join('\n');

const symbolsOf = (source: string): DocumentSymbol[] =>
    getDocumentSymbols(parser(lexer(source), 'file:///strings.rules').value, source);

const find = (symbols: DocumentSymbol[], name: string): DocumentSymbol => {
    for (const symbol of symbols) {
        if (symbol.name === name) return symbol;
        const child = symbol.children?.length ? findOrNull(symbol.children, name) : null;
        if (child) return child;
    }
    throw new Error(`no symbol named ${name}`);
};

const findOrNull = (symbols: DocumentSymbol[], name: string): DocumentSymbol | null => {
    for (const symbol of symbols) {
        if (symbol.name === name) return symbol;
        const child = symbol.children?.length ? findOrNull(symbol.children, name) : null;
        if (child) return child;
    }
    return null;
};

/** Every position of every symbol, so one walk can check them all against the file. */
const positionsOf = (symbols: DocumentSymbol[]): { line: number; character: number; of: string }[] => {
    const out: { line: number; character: number; of: string }[] = [];
    for (const symbol of symbols) {
        for (const range of [symbol.range, symbol.selectionRange]) {
            out.push({ ...range.start, of: symbol.name });
            out.push({ ...range.end, of: symbol.name });
        }
        if (symbol.children) out.push(...positionsOf(symbol.children));
    }
    return out;
};

describe('the outline of a document carrying a value over two lines', () => {
    it('ends the continued field on the line it really ends on', () => {
        const symbol = find(symbolsOf(SOURCE), 'Cont');
        expect(symbol.range.start).toEqual({ line: 2, character: 1 });
        expect(symbol.range.end).toEqual({ line: 3, character: 13 });
    });

    it('places every position of every symbol inside the file', () => {
        const lines = SOURCE.split('\n');
        for (const position of positionsOf(symbolsOf(SOURCE))) {
            expect(position.line, `${position.of} past the last line`).toBeLessThan(lines.length);
            expect(position.character, `${position.of} past the end of line ${position.line}`).toBeLessThanOrEqual(
                lines[position.line].length
            );
        }
    });

    it('leaves a field written on one line where it stands', () => {
        const symbol = find(symbolsOf(SOURCE), 'Plain');
        expect(symbol.range).toEqual({ start: { line: 4, character: 1 }, end: { line: 4, character: 12 } });
    });

    it('selects the brace an unnamed list element opens with', () => {
        const symbol = find(symbolsOf(SOURCE), '[0]');
        expect(symbol.selectionRange).toEqual({ start: { line: 7, character: 2 }, end: { line: 7, character: 3 } });
    });
});
