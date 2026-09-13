import { describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { removalRange } from '../../src/utils/removal-range';

const doc = (text: string) => TextDocument.create('file:///c%3A/mod/a.rules', 'rules', 1, text);

/** The file as the removal leaves it, which is what the author sees. */
const afterRemoving = (text: string, part: string): string => {
    const document = doc(text);
    const range = removalRange(document, text.indexOf(part), text.indexOf(part) + part.length);
    return text.slice(0, document.offsetAt(range.start)) + text.slice(document.offsetAt(range.end));
};

// The removal fix has to leave a file that still reads the way it did, so it takes the separator
// that belonged to what it removed and no blank line where a whole member stood.
describe('removalRange', () => {
    it('takes the line when nothing else stands on it', () => {
        expect(afterRemoving('Part\n{\n\tA = 1\n\tB = 2\n}\n', 'A = 1')).toBe('Part\n{\n\tB = 2\n}\n');
    });

    it('takes the separator with it when members share a line', () => {
        expect(afterRemoving('Part { A = 1, B = 2 }\n', 'A = 1')).toBe('Part { B = 2 }\n');
    });

    it('takes the separator in front of a last list element', () => {
        expect(afterRemoving('L [a, Foo]\n', 'Foo')).toBe('L [a]\n');
    });

    it('leaves the surrounding text alone when the member is the only one', () => {
        expect(afterRemoving('L [Foo]\n', 'Foo')).toBe('L []\n');
    });
});
