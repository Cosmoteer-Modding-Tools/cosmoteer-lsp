import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    validateMissingSeparators,
    validateRedundantSeparators,
    validateUnbracketedValueList,
} from '../../../src/features/diagnostics/validator.separator';
import { checkMissingFieldSeparator } from '../../../src/features/diagnostics/validator.assignment';
import { checkListElementSeparators } from '../../../src/features/diagnostics/validator.value';
import {
    AbstractNode,
    AssignmentNode,
    ValueNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../../src/core/ast/ast';

const token = CancellationToken.None;

const parse = (src: string, uri = 'file:///t.rules') => parser(lexer(src), uri).value;

const collect = (node: AbstractNode, out: AbstractNode[] = []): AbstractNode[] => {
    out.push(node);
    if (isGroupNode(node) || isListNode(node) || node.type === 'Document') {
        for (const child of (node as unknown as { elements: AbstractNode[] }).elements) collect(child, out);
    }
    if (isAssignmentNode(node)) {
        collect(node.left, out);
        if (node.right) collect(node.right, out);
    }
    return out;
};

const missingFieldFindings = async (src: string, uri?: string) => {
    const nodes = collect(parse(src, uri)).filter(isAssignmentNode);
    const results = await Promise.all(nodes.map((n) => checkMissingFieldSeparator(n as AssignmentNode, token)));
    return results.filter((r) => r !== undefined);
};

const listFindings = async (src: string, uri?: string) => {
    const nodes = collect(parse(src, uri)).filter(isValueNode);
    const results = await Promise.all(nodes.map((n) => checkListElementSeparators(n as ValueNode, token)));
    return results.filter((r) => r !== undefined);
};

describe('missing field separator (merged value + next field)', () => {
    it('flags two fields on one line with no separator', async () => {
        const findings = await missingFieldFindings('A = 1 B = 2');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.data?.quickFix?.newText).toBe('1, B');
    });

    it('flags each swallowed boundary of a longer run', async () => {
        const findings = await missingFieldFindings('A = 1 B = 2 C = 3');
        expect(findings).toHaveLength(2);
    });

    it('flags inside a group body', async () => {
        const findings = await missingFieldFindings('Foo { A = 1 B = 2 }');
        expect(findings).toHaveLength(1);
    });

    it('keeps a multi-token value in the quick fix', async () => {
        const findings = await missingFieldFindings('A = 1 2 B = 3');
        expect(findings[0]?.data?.quickFix?.newText).toBe('1 2, B');
    });

    it('accepts comma-separated fields on one line', async () => {
        expect(await missingFieldFindings('A = 1, B = 2')).toHaveLength(0);
    });

    it('accepts fields on separate lines', async () => {
        expect(await missingFieldFindings('A = 1\nB = 2')).toHaveLength(0);
    });

    it('does not flag an empty value followed by the next line field', async () => {
        expect(await missingFieldFindings('A =\nB = 2')).toHaveLength(0);
    });

    it('exempts strings files, whose values are localization text', async () => {
        expect(await missingFieldFindings('Key = Press X = pause', 'file:///mod/strings/en.rules')).toHaveLength(0);
    });
});

describe('missing list element separators (numeric run in one element)', () => {
    it('flags a run of numbers read as one element', async () => {
        const findings = await listFindings('L = [1 2 3]');
        expect(findings).toHaveLength(1);
        expect(findings[0]?.data?.quickFix?.newText).toBe('1, 2, 3');
    });

    it('flags numbers with expression suffixes', async () => {
        expect(await listFindings('L = [10% 20%]')).toHaveLength(1);
    });

    it('accepts properly separated elements', async () => {
        expect(await listFindings('L = [1, 2, 3]')).toHaveLength(0);
    });

    it('accepts a quoted multi-word string element', async () => {
        expect(await listFindings('L = ["1 2 3"]')).toHaveLength(0);
    });

    it('accepts unquoted multi-word text elements', async () => {
        expect(await listFindings('L = [foo bar]')).toHaveLength(0);
    });

    it('accepts elements on separate lines', async () => {
        expect(await listFindings('L = [\n\t1\n\t2\n]')).toHaveLength(0);
    });
});

// The game ends a flat field value at the line break, so a second member on that line is folded into
// the value and the whole file fails to load. A `{ … }` or `[ … ]` value ends at its own closer, which
// is why a member may follow one of those on the same line.
describe('a member the line before it swallows', () => {
    const findings = (src: string) => validateMissingSeparators(lexer(src));

    it('flags a member behind a quoted value (small_laser_graphics.rules)', () => {
        const result = findings('{ File = "a.png"     Size = [&x, &y] }');
        expect(result).toHaveLength(1);
        expect(result[0].message).toBe('The value before this swallows it');
        // The game accepts this shape and folds the member into the value before it, so this is a
        // warning about losing the member, not a load failure.
        expect(result[0].severity).toBe('warning');
    });

    it('anchors the finding to the swallowed name', () => {
        const src = '{ File = "a.png"     Size = [1, 2] }';
        const [finding] = findings(src);
        expect(src.slice(finding.node.position.start, finding.node.position.end)).toBe('Size');
    });

    it('flags each swallowed member of a longer run', () => {
        expect(findings('{ A = "x" B = "y" C = "z" }')).toHaveLength(2);
    });

    it('accepts members separated by a semicolon or a comma', () => {
        expect(findings('{ A = "x"; B = "y", C = "z" }')).toHaveLength(0);
    });

    it('accepts members on their own lines', () => {
        expect(findings('{\n\tA = "x"\n\tB = "y"\n}')).toHaveLength(0);
    });

    it('accepts a member behind a list value, which ends at its own closer', () => {
        expect(findings('{ Location = [0, 0] Direction = Left }')).toHaveLength(0);
    });

    it('accepts a member behind a group value', () => {
        expect(findings('{ Inner = { A = 1 } Direction = Left }')).toHaveLength(0);
    });

    it('accepts the members inside a value that opens a block', () => {
        expect(findings('X = { A = 1 B = 2 }')).toHaveLength(0);
    });

    it('accepts the mXparser relations, whose second half is an "="', () => {
        expect(findings('A = (&X) <= 3\nB = (&X) >= 3\nC = (&X) == 3\nD = (&X) != 3')).toHaveLength(0);
    });

    it('accepts a value that reaches the end of the file', () => {
        expect(findings('A = "x"')).toHaveLength(0);
    });
});

// A field carries one value, so the `,` after it ends the member and a reference behind that `,` is a
// member of its own, which the game refuses. The `,` of a list, of a call and of an inheritance list
// all take another value after them.
describe('a second reference hung on a field by a comma', () => {
    const findings = (src: string) => validateUnbracketedValueList(lexer(src));

    it('flags a comma separated reference pair (cosmoteer.rules)', () => {
        const result = findings('SW_PARTICLES = &<SW_effects/mod-particles.rules>, &<common_effects/mod-particles.rules>\n');
        expect(result).toHaveLength(1);
        expect(result[0].message).toBe('The game cannot read a standalone reference here');
    });

    it('anchors the finding to the second reference', () => {
        const src = 'X = &<a.rules>, &<b.rules>\n';
        const [finding] = findings(src);
        expect(src.slice(finding.node.position.start, finding.node.position.end)).toBe('&<b.rules>');
    });

    it('flags the pair inside a group', () => {
        expect(findings('G\n{\n\tX = &<a.rules>, &<b.rules>\n}\n')).toHaveLength(1);
    });

    it('accepts references collected in a list', () => {
        expect(findings('X = [&<a.rules>, &<b.rules>]\n')).toHaveLength(0);
    });

    it('accepts references in an inheritance list', () => {
        expect(findings('Components : ^/0/Components, &<doodads.rules>\n{\n\tA = 1\n}\n')).toHaveLength(0);
    });

    it('accepts references as function arguments', () => {
        expect(findings('X = min(&<a.rules>/A, &<b.rules>/B)\n')).toHaveLength(0);
    });

    it('accepts a plain field terminated by a comma', () => {
        expect(findings('A = 1, B = &<b.rules>\n')).toHaveLength(0);
    });
});

describe('redundant separators (line break already terminates)', () => {
    const findings = (src: string) => validateRedundantSeparators(lexer(src));

    it('flags a semicolon at the end of a line', () => {
        const result = findings('A = 1;\nB = 2');
        expect(result).toHaveLength(1);
        expect(result[0].severity).toBe('hint');
        expect(result[0].data?.quickFix?.newText).toBe('');
    });

    it('flags a trailing separator at end of file', () => {
        expect(findings('A = 1;')).toHaveLength(1);
    });

    it('flags a comma before a line break inside a list', () => {
        expect(findings('L = [\n\t1,\n\t2\n]')).toHaveLength(1);
    });

    it('flags a separator followed only by a line comment', () => {
        expect(findings('A = 1; // done\nB = 2')).toHaveLength(1);
    });

    it('accepts separators between entries on one line', () => {
        expect(findings('A = 1, B = 2; C = 3\nD = 4')).toHaveLength(0);
    });

    it('keeps a separator whose newline is suppressed by a line continuation', () => {
        expect(findings('A = 1; \\\nB = 2')).toHaveLength(0);
    });

    it('never flags function-argument commas', () => {
        expect(findings('X = min(1, 2)\nY = 3')).toHaveLength(0);
    });

    it('anchors the finding to the separator character', () => {
        const src = 'A = 1;\nB = 2';
        const [finding] = findings(src);
        expect(src.slice(finding.node.position.start, finding.node.position.end)).toBe(';');
    });
});
