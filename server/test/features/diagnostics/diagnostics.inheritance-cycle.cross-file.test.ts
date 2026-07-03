import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateInheritanceCycles } from '../../../src/features/diagnostics/validator.inheritance-cycle';
import { getStartOfAstNode } from '../../../src/utils/ast.utils';

// Cross-file inheritance is resolved by navigation, which re-parses the target file on every edge, so
// the resolved node is a fresh object each time. The cycle DFS therefore has to key its visited sets by
// a stable identity (uri + span), not by object reference. Before that fix a cross-file cycle recursed
// forever and a cross-file diamond re-descended exponentially, exhausting the heap on real mod parts.
const token = CancellationToken.None;
let dir: string;

const write = (name: string, src: string): void => writeFileSync(join(dir, name), src);
const cyclesOf = async (name: string) => {
    const uri = pathToFileURL(join(dir, name)).href;
    const doc = parser(lexer(readBack(name)), uri).value;
    return validateInheritanceCycles(doc, token);
};
const files = new Map<string, string>();
const readBack = (name: string): string => files.get(name)!;
const put = (name: string, src: string): void => {
    files.set(name, src);
    write(name, src);
};

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cyc-'));
});
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('circular inheritance across files', () => {
    it('flags a two-file cycle (a.rules → b.rules → a.rules) and terminates', async () => {
        put('a.rules', 'A : <b.rules>/B\n{\n\tOwnA = 1\n}\n');
        put('b.rules', 'B : <a.rules>/A\n{\n\tOwnB = 2\n}\n');
        const errors = await cyclesOf('a.rules');
        expect(errors.length).toBeGreaterThanOrEqual(1);
        expect(errors[0].message).toBe('Circular inheritance');
        // The back-edge closing this loop is b.rules' reference, but the error becomes a diagnostic
        // of a.rules, whose text maps the offsets — so it must be anchored to a node in a.rules.
        const uri = pathToFileURL(join(dir, 'a.rules')).href;
        expect(getStartOfAstNode(errors[0].node).uri).toBe(uri);
    }, 20_000);

    it('anchors a cycle found inside a foreign chain to the local entry reference', async () => {
        // Mirrors a real mod bug: a base file inherits its own /Part, and derived files inherit the
        // base. Validating the derived file finds the back-edge inside base.rules; the error must
        // land on the derived file's own inheritance reference, not on base.rules offsets.
        put('selfbase.rules', 'Part : <selfbase.rules>/Part\n{\n\tX = 1\n}\n');
        put('derived.rules', 'Part : <selfbase.rules>/Part\n{\n\tY = 2\n}\n');
        const errors = await cyclesOf('derived.rules');
        expect(errors.length).toBe(1);
        const uri = pathToFileURL(join(dir, 'derived.rules')).href;
        expect(getStartOfAstNode(errors[0].node).uri).toBe(uri);
        // Anchored to `<selfbase.rules>/Part` on line 1 of derived.rules, inside its own text.
        expect(errors[0].node.position.start).toBeGreaterThanOrEqual('Part : '.length);
        expect(errors[0].node.position.end).toBeLessThanOrEqual(readBack('derived.rules').indexOf('\n'));
    }, 20_000);

    it('does not flag a cross-file diamond and stays fast (no exponential re-descent)', async () => {
        // D inherits both L and R, both of which inherit the same Base file. Reaching Base by two
        // paths is a diamond, not a cycle. With object-identity keys each path re-parsed Base and
        // everything below it, which is what blew up. A stable key visits Base once.
        put('base.rules', 'Base\n{\n\tX = 1\n}\n');
        put('l.rules', 'L : <base.rules>/Base\n{\n}\n');
        put('r.rules', 'R : <base.rules>/Base\n{\n}\n');
        put('d.rules', 'D : <l.rules>/L, <r.rules>/R\n{\n}\n');
        const start = Date.now();
        const errors = await cyclesOf('d.rules');
        expect(errors).toEqual([]);
        expect(Date.now() - start).toBeLessThan(5_000);
    }, 20_000);
});
