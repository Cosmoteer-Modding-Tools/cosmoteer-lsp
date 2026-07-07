import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { formatRulesDocument } from '../../../src/features/formatting/rules-formatter';
import { FIXTURES_DIR } from '../../helpers';

const tabs = { tabSize: 4, insertSpaces: false };
const spaces = { tabSize: 4, insertSpaces: true };
const format = (text: string) => formatRulesDocument(text, tabs);

describe('.rules formatter', () => {
    it('re-indents nested groups and lists', () => {
        const input = 'Part\n{\nA = 1\nList\n[\n1,2\n]\n}\n';
        expect(format(input)).toBe('Part\n{\n\tA = 1\n\tList\n\t[\n\t\t1, 2\n\t]\n}\n');
    });

    it('uses spaces when the editor asks for them', () => {
        expect(formatRulesDocument('A\n{\nB = 1\n}\n', spaces)).toBe('A\n{\n    B = 1\n}\n');
    });

    it('normalizes spacing around = and the inheritance colon', () => {
        expect(format('A=1\n')).toBe('A = 1\n');
        expect(format('A   =   1\n')).toBe('A = 1\n');
        expect(format('Child:Parent\n{\n}\n')).toBe('Child : Parent\n{\n}\n');
    });

    it('normalizes comma and semicolon spacing', () => {
        expect(format('L = [1,2 ,3]\n')).toBe('L = [1, 2, 3]\n');
        expect(format('G { A = 1;B = 2 }\n')).toBe('G { A = 1; B = 2 }\n');
    });

    it('normalizes a line mixing semicolons and commas', () => {
        expect(format('G { A = 1;B = 2 , C = 3 }\n')).toBe('G { A = 1; B = 2, C = 3 }\n');
    });

    it('normalizes an inline group inside a list whose members are semicolon-separated', () => {
        expect(format('L = [ G{A=1;B=2} , H{C=3} ]\n')).toBe('L = [G { A = 1; B = 2 }, H { C = 3 }]\n');
    });

    it('removes padding inside parentheses and brackets but keeps inline brace padding', () => {
        expect(format('X = ( &A ) / ( &B )\n')).toBe('X = (&A) / (&B)\n');
        expect(format('L = [ 1, 2 ]\n')).toBe('L = [1, 2]\n');
        expect(format('G {A = 1}\n')).toBe('G { A = 1 }\n');
    });

    it('leaves the inside of unquoted values alone (spaces are value content)', () => {
        expect(format('Name = Big  Gun\n')).toBe('Name = Big  Gun\n');
    });

    it('never merges tokens that lex differently when joined', () => {
        // `10 - 3` is an expression, `10-3` would be a single value token. The gap must survive.
        expect(format('X = 10 - 3\n')).toBe('X = 10 - 3\n');
        expect(format('X = 10-3\n')).toBe('X = 10-3\n');
    });

    it('preserves tab gaps between two unquoted values (a space would merge them into one token)', () => {
        // Seen in the wild: notes files that column-align unquoted words with tabs.
        expect(format('chaingun.shader\t\t<- ./Data/shots\n')).toBe('chaingun.shader\t\t<- ./Data/shots\n');
    });

    it('bails on a file that is one unterminated block comment instead of altering it', () => {
        expect(format('/* never closed\nA = 1')).toBeNull();
    });

    it('stays safe on incomplete syntax while typing', () => {
        // Dangling assignment: the trailing space is trimmed, nothing else changes.
        expect(format('Part\n{\nA = \n}\n')).toBe('Part\n{\n\tA =\n}\n');
        // Unclosed group: following lines simply indent at the still-open depth.
        expect(format('Part\n{\nA = 1\n')).toBe('Part\n{\n\tA = 1\n');
        // Unclosed function call and paren mid-edit.
        expect(format('A = ceil((&B\nC = 2\n')).toBe('A = ceil((&B\nC = 2\n');
        // Unterminated string swallows the rest of the file as string content: kept verbatim.
        expect(format('A = "unterminated\nB = 2\n')).toBe('A = "unterminated\nB = 2\n');
        // Half-typed inheritance and a lone opening bracket.
        expect(format('Child :\n')).toBe('Child :\n');
        expect(format('List\n[\n')).toBe('List\n[\n');
    });

    it('never throws and stays idempotent on every prefix of a real file (typing simulation)', () => {
        const text = readFileSync(join(FIXTURES_DIR, 'math.rules'), 'utf8');
        for (let i = 1; i <= text.length; i++) {
            const prefix = text.slice(0, i);
            const once = formatRulesDocument(prefix, tabs);
            if (once === null) continue;
            expect(formatRulesDocument(once, tabs), `prefix of length ${i} diverged`).toBe(once);
        }
    });

    it('keeps a time literal with its colon untouched', () => {
        expect(format('TimeLimit = 30:00\n')).toBe('TimeLimit = 30:00\n');
    });

    it('indents comments to the surrounding depth, also right before a closing brace', () => {
        const input = 'A\n{\n// leading\nB = 1\n// before closer\n}\n';
        expect(format(input)).toBe('A\n{\n\t// leading\n\tB = 1\n\t// before closer\n}\n');
    });

    it('preserves inline trailing comments with their spacing', () => {
        expect(format('A\n{\nB = 1  // note\n}\n')).toBe('A\n{\n\tB = 1  // note\n}\n');
    });

    it('preserves multi-line strings verbatim', () => {
        const input = 'A = "line1\n   line2"\nB = 1\n';
        expect(format(input)).toBe(input);
    });

    it('preserves verbatim strings with doubled quotes', () => {
        const input = 'A = @"say ""hi""\nsecond"\n';
        expect(format(input)).toBe(input);
    });

    it('keeps a line continuation and indents the continued line one extra level', () => {
        expect(format('A = "x"\\\n"y"\n')).toBe('A = "x"\\\n\t"y"\n');
    });

    it('trims trailing whitespace and caps blank-line runs', () => {
        expect(format('A = 1   \n\n\n\n\nB = 2\n')).toBe('A = 1\n\n\nB = 2\n');
    });

    it('ends the file with exactly one newline', () => {
        expect(format('A = 1')).toBe('A = 1\n');
        expect(format('A = 1\n\n\n')).toBe('A = 1\n');
    });

    it('preserves CRLF line endings', () => {
        expect(format('A\r\n{\r\nB = 1\r\n}\r\n')).toBe('A\r\n{\r\n\tB = 1\r\n}\r\n');
    });

    it('leaves an empty document alone', () => {
        expect(format('')).toBe('');
        expect(format('\n')).toBe('\n');
    });

    it('is idempotent on every fixture and never bails on valid files', () => {
        const dir = FIXTURES_DIR;
        const files = readdirSync(dir).filter((f) => f.endsWith('.rules'));
        expect(files.length).toBeGreaterThan(5);
        for (const file of files) {
            const text = readFileSync(join(dir, file), 'utf8');
            const once = formatRulesDocument(text, tabs);
            expect(once, `formatter bailed on ${file}`).not.toBeNull();
            const twice = formatRulesDocument(once as string, tabs);
            expect(twice, `formatting ${file} twice diverged`).toBe(once);
        }
    });

    it('formats mod.rules actions like any other ObjectText', () => {
        const text = readFileSync(join(FIXTURES_DIR, 'mod', 'mod.rules'), 'utf8');
        const formatted = formatRulesDocument(text, tabs);
        expect(formatted).not.toBeNull();
        expect(formatRulesDocument(formatted as string, tabs)).toBe(formatted);
    });
});
