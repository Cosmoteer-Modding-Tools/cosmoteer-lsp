import { describe, expect, it } from 'vitest';
import { TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNodeDocument, GroupNode, isAssignmentNode, isGroupNode, isListNode } from '../../../src/core/ast/ast';
import {
    appendMemberEdit,
    memberIndentOf,
    memberSpan,
    overwriteValueEdit,
    spanIsCurrent,
    valueSpan,
} from '../../../src/features/refactor/rules-edit';

const parse = (text: string): AbstractNodeDocument => parser(lexer(text), 'file:///t.rules').value;

/** The first top-level group of a parsed document, which every case here writes into. */
const firstGroup = (document: AbstractNodeDocument): GroupNode => {
    const group = document.elements.find(isGroupNode);
    if (!group) throw new Error('the fixture has no top-level group');
    return group;
};

const lines = (...parts: string[]): string => parts.join('\n');

/** The file as one edit leaves it, which is the only thing a reader of the file ever sees. */
const applied = (text: string, edit: TextEdit | null): string => {
    if (!edit) throw new Error('the writer answered with no edit');
    return TextDocument.applyEdits(TextDocument.create('file:///t.rules', 'rules', 0, text), [edit]);
};

describe('appendMemberEdit indentation', () => {
    it('copies the indent of a plain sibling member', () => {
        const text = lines('Part {', '\t\tName = "x"', '}');
        const edit = appendMemberEdit(text, firstGroup(parse(text)), 'Bar = 2');
        expect(edit?.newText).toBe('\n\t\tBar = 2');
    });

    // A container member's `position.start` is its opening brace rather than its name, so reading
    // the prefix from there used to yield "\t\tFoo " instead of "\t\t". That failed the
    // whitespace-only test and silently fell back to a single tab, whatever the real depth was.
    it('keeps the sibling indent when the last member is a container', () => {
        const text = lines('Part {', '\t\tName = "x"', '\t\tFoo {', '\t\t\tA = 1', '\t\t}', '}');
        const edit = appendMemberEdit(text, firstGroup(parse(text)), 'Bar = 2');
        expect(edit?.newText).toBe('\n\t\tBar = 2');
    });

    it('falls back to the container depth when there is no member to copy', () => {
        const text = lines('Part {', '\tInner {', '\t}', '}');
        const document = parse(text);
        const inner = firstGroup(document).elements.find(isGroupNode);
        expect(inner).toBeTruthy();
        const edit = appendMemberEdit(text, inner as GroupNode, 'Bar = 2');
        // Two levels in, so two indent units rather than the one a flat fallback would write.
        expect(edit?.newText).toBe('\n\t\tBar = 2');
    });

    it('reads the indent unit from a file written with spaces', () => {
        const text = lines('Part {', '    Name = "x"', '}');
        expect(memberIndentOf(text, firstGroup(parse(text)))).toBe('    ');
    });
});

describe('appendMemberEdit placement', () => {
    it('appends after the last member by default', () => {
        const text = lines('Part {', '\tA = 1', '}');
        const edit = appendMemberEdit(text, firstGroup(parse(text)), 'B = 2');
        expect(edit?.newText).toBe('\n\tB = 2');
    });

    it('inserts before the closing brace when asked to', () => {
        const text = lines('Part {', '\tA = 1', '}');
        const edit = appendMemberEdit(text, firstGroup(parse(text)), 'B = 2', { placement: 'beforeCloser' });
        expect(edit?.newText).toBe('\tB = 2\n');
    });

    // A note the author wrote about one field used to end up on the line below, reading as a note
    // about a field they never wrote, and a diff made it look as though they had edited it.
    it('leaves a trailing line comment on the member it was written about', () => {
        const text = lines('Part {', '\tA = 1 // the save files name it', '}');
        const edit = appendMemberEdit(text, firstGroup(parse(text)), 'B = 2');
        expect(applied(text, edit)).toBe(lines('Part {', '\tA = 1 // the save files name it', '\tB = 2', '}'));
    });

    it('leaves a trailing block comment on the member it was written about', () => {
        const text = lines('Part {', '\tA = 1 /* the save files name it */', '}');
        const edit = appendMemberEdit(text, firstGroup(parse(text)), 'B = 2');
        expect(applied(text, edit)).toBe(lines('Part {', '\tA = 1 /* the save files name it */', '\tB = 2', '}'));
    });

    it('keeps a trailing comment where it is when inserting before the closer', () => {
        const text = lines('Part {', '\tA = 1 // note', '}');
        const edit = appendMemberEdit(text, firstGroup(parse(text)), 'B = 2', { placement: 'beforeCloser' });
        expect(applied(text, edit)).toBe(lines('Part {', '\tA = 1 // note', '\tB = 2', '}'));
    });

    it('appends inline into a one-line list when a separator is given', () => {
        const text = 'Sizes [ 1, 2 ]';
        const list = parse(text).elements.find(isListNode);
        expect(list).toBeTruthy();
        const edit = appendMemberEdit(text, list!, '3', { inlineSeparator: ', ' });
        expect(edit?.newText).toBe(', 3');
    });
});

describe('valueSpan', () => {
    // The parser drops a leading `(` from a value's span while keeping the trailing `)`, so a raw
    // span replace over `(9500)` used to leave a stray `(`.
    it('covers the whole parenthesized value, both brackets included', () => {
        const text = 'Part {\n\tCost = (9500)\n}';
        const assignment = firstGroup(parse(text)).elements.find(isAssignmentNode);
        expect(assignment?.right).toBeTruthy();
        const span = valueSpan(text, assignment!.right!);
        expect(text.slice(span.start, span.end)).toBe('(9500)');
    });

    it('overwrites a parenthesized value without leaving a bracket behind', () => {
        const text = 'Part {\n\tCost = (9500)\n}';
        const assignment = firstGroup(parse(text)).elements.find(isAssignmentNode);
        const edit = overwriteValueEdit(text, assignment!.right!, '1');
        const start = text.indexOf('(9500)');
        expect(text.slice(0, start) + edit.newText + text.slice(start + '(9500)'.length)).toBe('Part {\n\tCost = 1\n}');
    });

    it('covers a plain value exactly', () => {
        const text = 'Part {\n\tCost = 9500\n}';
        const assignment = firstGroup(parse(text)).elements.find(isAssignmentNode);
        const span = valueSpan(text, assignment!.right!);
        expect(text.slice(span.start, span.end)).toBe('9500');
    });
});

describe('memberSpan and spanIsCurrent', () => {
    it('runs an assignment from its name to the end of its value', () => {
        const text = 'Part {\n\tCost = 9500\n}';
        const assignment = firstGroup(parse(text)).elements.find(isAssignmentNode);
        const span = memberSpan(assignment!);
        expect(span).toBeTruthy();
        expect(text.slice(span!.start, span!.end)).toBe('Cost = 9500');
    });

    it('runs a named container from its identifier to its closer', () => {
        const text = 'Part {\n\tFoo {\n\t\tA = 1\n\t}\n}';
        const inner = firstGroup(parse(text)).elements.find(isGroupNode);
        const span = memberSpan(inner!);
        expect(text.slice(span!.start, span!.end)).toBe('Foo {\n\t\tA = 1\n\t}');
    });

    // The table walk holds nodes from an earlier parse, so a span it kept may no longer describe
    // what is in the buffer. Writing through a stale span is what corrupts a file.
    it('rejects a span whose text has moved under it', () => {
        const text = 'Part {\n\tCost = 9500\n}';
        const assignment = firstGroup(parse(text)).elements.find(isAssignmentNode);
        expect(spanIsCurrent(text, assignment!.right!)).toBe(true);
        expect(spanIsCurrent('Part {\n\tCost = 1\n}', assignment!.right!)).toBe(false);
    });
});
