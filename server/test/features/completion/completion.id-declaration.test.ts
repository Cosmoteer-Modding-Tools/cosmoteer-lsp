import { beforeAll, describe, expect, it } from 'vitest';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { isIdDeclarationPositionAt } from '../../../src/features/completion/autocompletion.schema-fields';
import { initWorkspace } from '../../workspace-helper';

const URI = 'file:///parts/test_part/test_part.rules';

/** Whether the caret marked by `|` in the source sits at an id-declaration slot. */
const declaresIdAtCaret = (source: string): boolean => {
    const offset = source.indexOf('|');
    const text = source.replace('|', '');
    const document = parser(lexer(text), URI).value;
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    return isIdDeclarationPositionAt(document, offset, text.slice(lineStart, offset));
};

// `PartRules.ID` is schema-typed as a reference to PartRules, so the id popup used to answer a
// declaration slot with every id the project had already taken, which is the one set that cannot be
// used there.
describe('id declaration positions', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('sees a part declaring its own id', () => {
        expect(declaresIdAtCaret('Part\n{\n\tID = |\n}\n')).toBe(true);
    });

    it('sees the legacy alias list, both as a value and as an element', () => {
        expect(declaresIdAtCaret('Part\n{\n\tOtherIDs = |\n}\n')).toBe(true);
        expect(declaresIdAtCaret('Part\n{\n\tOtherIDs = [ | ]\n}\n')).toBe(true);
    });

    it('leaves a field that names other parts alone', () => {
        expect(declaresIdAtCaret('Part\n{\n\tEditorParentParts = [ | ]\n}\n')).toBe(false);
    });

    it('leaves an ordinary value position alone', () => {
        expect(declaresIdAtCaret('Part\n{\n\tNameKey = |\n}\n')).toBe(false);
    });
});
