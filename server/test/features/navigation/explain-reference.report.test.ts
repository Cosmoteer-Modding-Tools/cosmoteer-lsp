import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'path';
import { CancellationToken, Position } from 'vscode-languageserver';
import { AbstractNodeDocument, IdentifierNode, isIdentifierNode } from '../../../src/core/ast/ast';
import {
    ReferenceTrace,
    traceReference,
} from '../../../src/features/navigation/explain-reference/reference-trace';
import {
    generateReferenceTraceReport,
    renderReferenceTrace,
} from '../../../src/features/navigation/explain-reference/reference-trace.report';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { FIXTURES_DIR, findReferenceNode, parseFixture, walkAst } from '../../helpers';

// The report is what a user actually reads, so its shape is pinned here: one row per hop, deep links
// that open the right file at the right line, a cut for a value too long to sit on one line, and the
// two refusals showing as a plain sentence rather than as advice.
const token = CancellationToken.None;
const TRACE_DIR = join(FIXTURES_DIR, 'reference-trace');

/** A trace with only the fields a shape test needs, the rest left in their empty state. */
const traceOf = (overrides: Partial<ReferenceTrace>): ReferenceTrace => ({
    written: '&A/B',
    walked: '&A/B',
    at: { uri: 'C:\\mods\\my mod\\part.rules', line: 3 },
    verdict: 'broken',
    hops: [
        { segment: 'A', kind: 'member', resolved: true, reached: true, landedOn: { uri: 'C:\\mods\\my mod\\part.rules', line: 7 }, landedKind: 'group' },
        { segment: 'B', kind: 'member', resolved: false, reached: true },
    ],
    failedAt: 1,
    lastGood: { uri: 'C:\\mods\\my mod\\part.rules', line: 7 },
    available: { kind: 'members', names: [], total: 0, incomplete: false },
    virtualTargets: [],
    actionTarget: false,
    ...overrides,
});

describe('reference trace report: shape', () => {
    it('writes one row per hop, in order', () => {
        const markdown = renderReferenceTrace(traceOf({}));
        expect(markdown).toContain('| 1 | `A` |');
        expect(markdown).toContain('| 2 | `B` |');
        expect(markdown.indexOf('| 1 | `A` |')).toBeLessThan(markdown.indexOf('| 2 | `B` |'));
    });

    it('links a place as file.rules:line through the vscode file scheme, with the drive letter kept', () => {
        const markdown = renderReferenceTrace(traceOf({}));
        expect(markdown).toContain('[part.rules:4](vscode://file/C%3A/mods/my%20mod/part.rules:4)');
    });

    it('links a uri and the same path written as an os path identically', () => {
        const asUri = renderReferenceTrace(traceOf({ at: { uri: 'file:///C%3A/mods/my%20mod/part.rules', line: 3 } }));
        expect(asUri).toContain('[part.rules:4](vscode://file/C%3A/mods/my%20mod/part.rules:4)');
    });

    it('cuts a written value that is too long for a line', () => {
        const long = '&' + 'Very_Long_Segment_Name/'.repeat(6);
        const markdown = renderReferenceTrace(
            traceOf({ available: { kind: 'alias', text: long, declaredAt: undefined } })
        );
        expect(markdown).toContain('…');
        expect(markdown).not.toContain(long);
    });

    it('says how many members it is not listing', () => {
        const markdown = renderReferenceTrace(
            traceOf({
                available: {
                    kind: 'members',
                    names: [{ name: 'Kept', origin: { uri: 'C:\\mods\\my mod\\part.rules', line: 7 }, inherited: false }],
                    total: 44,
                    incomplete: false,
                },
            })
        );
        expect(markdown).toContain('43 more members are not listed.');
    });

    it('warns when a base could not be read, so the member list is not the whole answer', () => {
        const markdown = renderReferenceTrace(
            traceOf({ available: { kind: 'members', names: [], total: 0, incomplete: true } })
        );
        expect(markdown).toContain('could not be read');
    });
});

describe('reference trace report: content', () => {
    let shapes: AbstractNodeDocument;

    beforeAll(async () => {
        shapes = await parseFilePath(join(TRACE_DIR, 'shapes.rules'));
    });

    it('puts the correction and the member table in front of the step list', async () => {
        const result = await traceReference(findReferenceNode(shapes, '&Etxra'), token);
        const markdown = renderReferenceTrace(result!);
        expect(markdown).toContain('Did you mean `Extra`?');
        expect(markdown).toContain('| `Extra` |');
        expect(markdown.indexOf('Did you mean')).toBeLessThan(markdown.indexOf('Every step'));
    });

    it('offers nothing at all for a `~` path, which is the whole point of the refusal', async () => {
        const runtime = parseFixture('runtime-root-ref.rules');
        for (const reference of ['&~/EMITTER/BeamCount', '&~/RealRoot/Missing']) {
            const result = await traceReference(findReferenceNode(runtime, reference), token);
            const markdown = renderReferenceTrace(result!);
            expect(markdown).not.toContain('Did you mean');
            expect(markdown).toContain('No member names are listed here on purpose.');
        }
    });

    it('says a member is there and the reference it holds is not', async () => {
        const cycle = parseFixture('ref-cycle.rules');
        const result = await traceReference(findReferenceNode(cycle, '&A/x'), token);
        const markdown = renderReferenceTrace(result!);
        expect(markdown).not.toContain('Did you mean');
        expect(markdown).toContain('comes back to itself');
        expect(markdown).toContain('`&B`');
    });

    it('names the folder searched for a file that is not there', async () => {
        const result = await traceReference(findReferenceNode(shapes, '&<missing.rules>/Anything'), token);
        const markdown = renderReferenceTrace(result!);
        expect(markdown).toContain('There is no such file.');
        expect(markdown).toContain('not reached');
    });
});

describe('reference trace report: the caret', () => {
    let shapes: AbstractNodeDocument;

    beforeAll(async () => {
        shapes = await parseFilePath(join(TRACE_DIR, 'shapes.rules'));
    });

    it('answers for the reference under the caret', async () => {
        const node = findReferenceNode(shapes, '&Etxra');
        const caret = Position.create(node.position.line, node.position.characterStart + 2);
        expect(await generateReferenceTraceReport(shapes, caret, token)).toContain('Did you mean `Extra`?');
    });

    it('answers for the field name the reference is assigned to', async () => {
        // `Typo = &Etxra`: resting on the field's name is the same question, asked from a few
        // characters to the left.
        const node = findReferenceNode(shapes, '&Etxra');
        const caret = Position.create(node.position.line, 2);
        expect(await generateReferenceTraceReport(shapes, caret, token)).toContain('Did you mean `Extra`?');
    });

    it('answers for a bare reference standing alone as a list element', async () => {
        // The parser reads such an element as an identifier rather than as a value, so without the
        // wrap the caret would find nothing to explain on a shape the game's own files are full of.
        const bare = [...walkAst(shapes)].find(
            (node) => isIdentifierNode(node) && node.name === '&../../Base/Kept'
        ) as IdentifierNode;
        const caret = Position.create(bare.position.line, bare.position.characterStart + 1);
        const markdown = await generateReferenceTraceReport(shapes, caret, token);
        expect(markdown).toContain('Every step resolves.');
    });

    it('answers nothing when the caret is not on a reference', async () => {
        expect(await generateReferenceTraceReport(shapes, Position.create(0, 0), token)).toBeNull();
    });
});
