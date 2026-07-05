import { describe, expect, it } from 'vitest';
import { DocumentSymbol, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { DocumentSymbolService } from '../../../src/features/navigation/document-symbol.service';
import { findNodeAtPosition } from '../../../src/utils/ast.utils';

// Particle/effect files carry constructs that other `.rules` files rarely do: bare keys with no
// value (`VelocityIn`, `EmitPerOneShot`) and mid-edit empty assignments (`AIn = `). These produce
// AST nodes with missing/degenerate positions that previously crashed find-node and broke the
// outline's range-containment invariant.
const SRC = [
    'Type = Particles',
    'Def',
    '{',
    '\tInitializers',
    '\t[',
    '\t\t{',
    '\t\t\tType = FpsCompensator',
    '\t\t\tVelocityIn',
    '\t\t\tAIn = ',
    '\t\t\tName = "x"',
    '\t\t}',
    '\t]',
    '}',
    'EmitterDef',
    '{',
    '\tEmitPerOneShot',
    '}',
].join('\n');

const parse = () => parser(lexer(SRC), 'file:///e.rules').value;

const contains = (outer: Range, inner: Range): boolean =>
    (outer.start.line < inner.start.line ||
        (outer.start.line === inner.start.line && outer.start.character <= inner.start.character)) &&
    (outer.end.line > inner.end.line ||
        (outer.end.line === inner.end.line && outer.end.character >= inner.end.character));

const eachSymbol = (symbols: DocumentSymbol[], visit: (s: DocumentSymbol) => void): void => {
    for (const s of symbols) {
        visit(s);
        eachSymbol(s.children ?? [], visit);
    }
};

describe('particle-file robustness', () => {
    it('builds the outline without throwing and keeps selectionRange within range everywhere', () => {
        const symbols = DocumentSymbolService.instance.getDocumentSymbols(parse());
        eachSymbol(symbols, (s) => {
            expect(contains(s.range, s.selectionRange), `selectionRange escapes range for ${s.name}`).toBe(true);
            for (const child of s.children ?? []) {
                expect(contains(s.range, child.range), `child ${child.name} escapes parent ${s.name}`).toBe(true);
            }
        });
    });

    it('find-node-at-position does not throw at an empty `AIn = ` value', () => {
        const doc = parse();
        const line = SRC.split('\n').findIndex((l) => l.includes('AIn = '));
        expect(() => findNodeAtPosition(doc, { line, character: SRC.split('\n')[line].length })).not.toThrow();
    });

    it('find-node-at-position does not throw on a bare key with no value', () => {
        const doc = parse();
        const line = SRC.split('\n').findIndex((l) => l.includes('VelocityIn'));
        expect(() => findNodeAtPosition(doc, { line, character: 6 })).not.toThrow();
    });
});
