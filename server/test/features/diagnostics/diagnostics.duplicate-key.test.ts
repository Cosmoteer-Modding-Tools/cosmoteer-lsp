import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    ValidationForDocumentDuplicates,
    ValidationForGroupDuplicates,
} from '../../../src/features/diagnostics/validator.duplicate-key';
import { AbstractNode, AbstractNodeDocument, GroupNode, isGroupNode } from '../../../src/core/ast/ast';
import { walkAst } from '../../helpers';

const token = CancellationToken.None;
const parse = (src: string): AbstractNodeDocument => parser(lexer(src), 'file:///dup.rules').value;
const firstGroup = (doc: AbstractNodeDocument): GroupNode => {
    for (const node of walkAst(doc as AbstractNode)) if (isGroupNode(node)) return node;
    throw new Error('no group parsed');
};

describe('duplicate field diagnostics', () => {
    it('flags a field assigned twice in the same group', async () => {
        const error = await ValidationForGroupDuplicates.callback(firstGroup(parse('G\n{\n\tX = 1\n\tX = 2\n}\n')), token);
        expect(error?.message).toBe('Duplicate field "X"');
        expect(error?.additionalInfo).toContain('only the last definition takes effect');
    });

    it('flags two identified sub-groups with the same name', async () => {
        const error = await ValidationForGroupDuplicates.callback(
            firstGroup(parse('G\n{\n\tInner\n\t{\n\t}\n\tInner\n\t{\n\t}\n}\n')),
            token
        );
        expect(error?.message).toBe('Duplicate field "Inner"');
    });

    it('flags duplicate top-level fields at the document root', async () => {
        const error = await ValidationForDocumentDuplicates.callback(parse('A = 1\nA = 2\n'), token);
        expect(error?.message).toBe('Duplicate field "A"');
    });

    it('does not flag distinct field names', async () => {
        expect(await ValidationForGroupDuplicates.callback(firstGroup(parse('G\n{\n\tX = 1\n\tY = 2\n}\n')), token)).toBeUndefined();
    });

    it('treats names case-sensitively (Foo and foo are distinct)', async () => {
        expect(await ValidationForGroupDuplicates.callback(firstGroup(parse('G\n{\n\tFoo = 1\n\tfoo = 2\n}\n')), token)).toBeUndefined();
    });

    it('does not flag repeated positional values in a list', async () => {
        // The list's entries are anonymous/positional, so repetition is allowed.
        const doc = parse('G\n{\n\tNums\n\t[\n\t\t1\n\t\t1\n\t]\n}\n');
        expect(await ValidationForGroupDuplicates.callback(firstGroup(doc), token)).toBeUndefined();
    });
});
