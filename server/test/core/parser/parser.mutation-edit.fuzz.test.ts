import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { DocumentSymbolService } from '../../../src/features/navigation/document-symbol.service';
import { DocumentSymbol } from 'vscode-languageserver';

// The existing prefix fuzz (parser.fuzz.test.ts) models typing a document from scratch. But the
// live-edit operation that actually bites is inserting or deleting a single character in the middle
// of an already-complete file. That is what produced both the `documentSymbol` "selectionRange must
// be contained in fullRange" crash (a stray `[` before a group) and the `continueMathExpression`
// throw (a `=` turning a math operand into an assignment). This sweep reproduces that operation
// against real fixtures and asserts two invariants the editor relies on: the parser never throws, and
// every emitted document symbol satisfies the LSP containment rule, checked exactly as the client
// does, swap-normalizing reversed ranges first (a container's own position is a reversed range even
// in valid files, so the naive line-only check would miss it).
const FIXTURES = join(__dirname, '../../fixtures');
const symService = DocumentSymbolService.instance;

// Structural characters most likely to malform an otherwise-valid file mid-edit.
const INSERT_CHARS = ['[', ']', '{', '}', ':', '=', '&', '(', ')'];

const atOrBefore = (aLine: number, aChar: number, bLine: number, bChar: number): boolean =>
    aLine < bLine || (aLine === bLine && aChar <= bChar);
const ordered = (r: DocumentSymbol['range']) =>
    atOrBefore(r.start.line, r.start.character, r.end.line, r.end.character) ? r : { start: r.end, end: r.start };

/** Assert (client-style) that selectionRange sits within range for a symbol and all descendants. */
const assertContained = (sym: DocumentSymbol, ctx: string): void => {
    const range = ordered(sym.range);
    const sel = ordered(sym.selectionRange);
    const ok =
        atOrBefore(range.start.line, range.start.character, sel.start.line, sel.start.character) &&
        atOrBefore(sel.end.line, sel.end.character, range.end.line, range.end.character);
    expect(ok, `${ctx}: selectionRange ${JSON.stringify(sym.selectionRange)} escaped range ${JSON.stringify(sym.range)}`).toBe(true);
    sym.children?.forEach((c) => assertContained(c, ctx));
};

const exercise = (text: string, ctx: string): void => {
    let doc;
    expect(() => (doc = parser(lexer(text), 'file:///t.rules').value), `${ctx}: parse threw`).not.toThrow();
    if (!doc) return;
    let symbols: DocumentSymbol[] = [];
    expect(() => (symbols = symService.getDocumentSymbols(doc!)), `${ctx}: documentSymbol threw`).not.toThrow();
    symbols.forEach((s) => assertContained(s, ctx));
};

describe('parser mutation-edit fuzz: single-char insert/delete into complete files', () => {
    const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.rules'));

    for (const name of fixtures) {
        it(
            `survives every single-char edit of ${name}`,
            () => {
                let base = readFileSync(join(FIXTURES, name), 'utf-8');
                // Bound the larger fixtures so the sweep stays quick even under CI contention.
                if (base.length > 1500) base = base.slice(0, 1500);
                exercise(base, `${name} baseline`);
                for (let i = 0; i < base.length; i++) {
                    for (const c of INSERT_CHARS) {
                        exercise(base.slice(0, i) + c + base.slice(i), `${name} +'${c}'@${i}`);
                    }
                    exercise(base.slice(0, i) + base.slice(i + 1), `${name} del@${i}`);
                }
            },
            30000
        );
    }
});
