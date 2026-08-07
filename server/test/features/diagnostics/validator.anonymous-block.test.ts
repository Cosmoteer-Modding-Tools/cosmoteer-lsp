import { describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { validateAnonymousBlocks } from '../../../src/features/diagnostics/validator.anonymous-block';

const token = CancellationToken.None;

const findings = (src: string) => validateAnonymousBlocks(parser(lexer(src), 'file:///t.rules').value, token);

describe('unnamed blocks outside a list', () => {
    it('flags a mod action written without its Actions list (Ga.rules)', async () => {
        const result = await findings(
            '{\n\tAction = AddMany\n\tAddTo = "<gui/part_toggles.rules>/PartToggles"\n}\n'
        );
        expect(result).toHaveLength(1);
        expect(result[0].message).toBe('This block needs a name');
    });

    it('flags every unnamed block of a document', async () => {
        expect(await findings('{\n\tA = 1\n}\n{\n\tB = 2\n}\n')).toHaveLength(2);
    });

    it('flags an unnamed block inside a group', async () => {
        expect(await findings('G\n{\n\tA = 1\n\t{\n\t\tB = 2\n\t}\n}\n')).toHaveLength(1);
    });

    it('flags an unnamed list inside a group', async () => {
        expect(await findings('G\n{\n\tA = 1\n\t[\n\t\t1\n\t]\n}\n')).toHaveLength(1);
    });

    it('accepts a named block', async () => {
        expect(await findings('G\n{\n\tA = 1\n}\nL\n[\n\t1\n]\n')).toHaveLength(0);
    });

    it('accepts a block assigned to a field', async () => {
        expect(await findings('X = { }\nY = [ ]\nZ = {\n\tA = 1\n}\n')).toHaveLength(0);
    });

    it('accepts a block that hangs off an inheritance', async () => {
        expect(await findings('Child : Base { A = 1 }\nOther : Base\n{\n\tB = 2\n}\n')).toHaveLength(0);
    });

    it('accepts unnamed elements of a list, whose position is their name', async () => {
        expect(await findings('L\n[\n\t{ A = 1 }\n\t{ A = 2 }\n\t[ 1, 2 ]\n]\n')).toHaveLength(0);
    });

    it('accepts a line-leading inheritance element of a list', async () => {
        expect(await findings('L\n[\n\t: ~/Base; { A = 1 }\n]\n')).toHaveLength(0);
    });

    it('reaches an unnamed block nested inside an assigned block', async () => {
        expect(await findings('X =\n{\n\tA = 1\n\t{\n\t\tB = 2\n\t}\n}\n')).toHaveLength(1);
    });

    it('anchors the finding to the block', async () => {
        const src = 'G\n{\n\t{\n\t\tB = 2\n\t}\n}\n';
        const [finding] = await findings(src);
        expect(src.slice(finding.node.position.start, finding.node.position.start + 1)).toBe('{');
    });
});
