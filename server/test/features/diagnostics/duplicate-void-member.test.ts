import { describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode } from '../../../src/core/ast/ast';
import {
    ValidationForDocumentDuplicates,
    ValidationForGroupDuplicates,
} from '../../../src/features/diagnostics/validator.duplicate-key';

const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///probe.rules').value;

/** The duplicate finding of the document root, or of the one group it holds. */
const finding = async (src: string, inGroup = false): Promise<string | undefined> => {
    const document = parse(src);
    const scope = inGroup ? (document.elements.find(isGroupNode) as GroupNode) : document;
    const run = inGroup ? ValidationForGroupDuplicates.callback : ValidationForDocumentDuplicates.callback;
    const found = await (run as (node: AbstractNode) => Promise<{ message: string } | undefined>)(scope);
    return found?.message;
};

// A bare word with no value and no body is a member to the game: it builds an `OTVoidNode` and
// registers it under that name. Running these through the shipped HalflingCore parser answers
// `OTParseException: Group at path '<>' already contains a node named 'A'`, so the file does not
// load. The word after a `,` in a group-level `X = a, b` is the same kind of member: the game reads
// that file as `X` holding `"a"` plus a sibling void member named `b`.
describe('a void member', () => {
    it('counts against a field of the same name', async () => {
        expect(await finding('A\nA = 1\n')).toContain('Duplicate field "A"');
    });

    it('counts against another void member of the same name, ignoring case', async () => {
        expect(await finding('Ab\naB\n')).toContain('Duplicate field "aB"');
        expect(await finding('G\n{\n\tFoo\n\tfoo\n}\n', true)).toContain('Duplicate field "foo"');
    });

    it('counts when the comma of a group-level multi-value leaves one behind', async () => {
        expect(await finding('X = a, b\nB = 9\n')).toContain('Duplicate field "B"');
        expect(await finding('X = a, b\nb = 9\n')).toContain('Duplicate field "b"');
    });

    it('says nothing about two void members with different names', async () => {
        expect(await finding('A\nB\n')).toBeUndefined();
        expect(await finding('A;\nB = 1\n')).toBeUndefined();
    });

    it('says nothing about a name a group or a list takes as its own', async () => {
        // `A` here names the group under it rather than standing alone, so it is one member.
        expect(await finding('A\n{\n\tQ = 1\n}\n')).toBeUndefined();
        expect(await finding('A\n[\n\t1\n]\n')).toBeUndefined();
    });

    it('says nothing about the positional elements of a list', async () => {
        expect(await finding('L [ a, a ]\n')).toBeUndefined();
    });

    it('says nothing about a group-level value that is not a name', async () => {
        // The game refuses `X = a, "b"` and `A = 1, 2` outright rather than reading a void member
        // out of them, so neither contributes a key here.
        expect(await finding('X = a, "b"\nb = 9\n')).toBeUndefined();
        expect(await finding('A = 1, 2\nB = 3\n')).toBeUndefined();
    });
});
