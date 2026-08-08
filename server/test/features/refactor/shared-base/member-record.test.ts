import { describe, expect, it } from 'vitest';
import { isGroupNode } from '../../../../src/core/ast/ast';
import { parseText } from '../../../../src/utils/ast.utils';
import {
    commentRanges,
    normalizeMemberText,
    overlapsComment,
    topLevelMembersOf,
} from '../../../../src/features/refactor/shared-base/member-record';

/** The `Part` group's member records for a file's source. */
const membersOf = (text: string) => {
    const document = parseText(text, 'C:/mod/parts/part.rules');
    const group = document.elements.find(isGroupNode);
    if (!group) throw new Error('the fixture text parsed without a Part group');
    return topLevelMembersOf(group, text);
};

describe('normalizeMemberText', () => {
    it('compares two files that indent the same member differently as equal', () => {
        const tabs = 'Part\n{\n\tCrewSpeedFactor\n\t{\n\t\tForward = 1\n\t\tSideways = 0.5\n\t}\n}\n';
        const spaces = 'Part\n{\n    CrewSpeedFactor\n    {\n        Forward = 1\n        Sideways = 0.5\n    }\n}\n';
        const fromTabs = membersOf(tabs)[0];
        const fromSpaces = membersOf(spaces)[0];
        expect(fromTabs.raw).not.toBe(fromSpaces.raw);
        expect(fromTabs.indent).toBe('\t');
        expect(fromSpaces.indent).toBe('    ');
        expect(fromTabs.norm).toBe(fromSpaces.norm);
    });

    it('keeps line structure, since a newline ends an entry for the game', () => {
        const multiLine = normalizeMemberText('CrewSpeedFactor\n{\n\tForward = 1\n}');
        const oneLine = normalizeMemberText('CrewSpeedFactor { Forward = 1 }');
        expect(multiLine).toBe('CrewSpeedFactor\n{\nForward = 1\n}');
        expect(oneLine).toBe('CrewSpeedFactor { Forward = 1 }');
        expect(multiLine).not.toBe(oneLine);
    });

    it('collapses runs of spaces and tabs inside a line', () => {
        expect(normalizeMemberText('Density  =\t\t3')).toBe('Density = 3');
    });

    it('drops blank lines and the whitespace they carry', () => {
        expect(normalizeMemberText('Sprite\n{\n\n\tFile = a.png\n   \n}')).toBe('Sprite\n{\nFile = a.png\n}');
    });

    it('drops a trailing separator, so a comma-terminated member matches an unterminated one', () => {
        expect(normalizeMemberText('Density = 3,')).toBe('Density = 3');
        expect(normalizeMemberText('Density = 3; ')).toBe('Density = 3');
        expect(normalizeMemberText('Density = 3,')).toBe(normalizeMemberText('Density = 3'));
    });

    it('does not equate two different values that only look alike after trimming', () => {
        expect(normalizeMemberText('Density = 3')).not.toBe(normalizeMemberText('Density = 30'));
    });
});

describe('commentRanges', () => {
    it('spans a line comment up to the newline, leaving the newline outside', () => {
        const text = 'Density = 3 // tuned\nIsRotateable = false\n';
        expect(commentRanges(text)).toEqual([{ start: 12, end: text.indexOf('\n') }]);
    });

    it('closes a block comment at its first closing marker', () => {
        const text = 'A /* one */ B /* two */ C';
        expect(commentRanges(text)).toEqual([
            { start: 2, end: 11 },
            { start: 14, end: 23 },
        ]);
        expect(text.slice(2, 11)).toBe('/* one */');
    });

    it('runs an unterminated block comment to the end of the file', () => {
        const text = 'Density = 3\n/* forgot to close';
        expect(commentRanges(text)).toEqual([{ start: 12, end: text.length }]);
    });

    it('reads a comment marker inside a quoted string as text', () => {
        expect(commentRanges('NameKey = "https://example.com/a"\n')).toEqual([]);
        expect(commentRanges('NameKey = "/* not a comment */"\n')).toEqual([]);
    });

    it('returns the spans in ascending, non-overlapping order', () => {
        const ranges = commentRanges('// a\nX = 1 /* b */\n// c\n');
        expect(ranges).toHaveLength(3);
        for (let i = 1; i < ranges.length; i++) expect(ranges[i - 1].end).toBeLessThanOrEqual(ranges[i].start);
    });
});

describe('overlapsComment', () => {
    const ranges = [
        { start: 10, end: 20 },
        { start: 40, end: 50 },
    ];

    it('reports a span a comment reaches into', () => {
        expect(overlapsComment(ranges, 15, 25)).toBe(true);
        expect(overlapsComment(ranges, 5, 12)).toBe(true);
        expect(overlapsComment(ranges, 12, 18)).toBe(true);
    });

    it('leaves a span that only meets a comment at its edge alone', () => {
        expect(overlapsComment(ranges, 20, 30)).toBe(false);
        expect(overlapsComment(ranges, 0, 10)).toBe(false);
        expect(overlapsComment(ranges, 25, 35)).toBe(false);
    });
});

describe('topLevelMembersOf', () => {
    it('spans a member from its name to the end of its value, not from its brace', () => {
        const text = 'Part\n{\n\tDensity = 3\n\tCrewSpeedFactor\n\t{\n\t\tForward = 1\n\t}\n}\n';
        const [density, crewSpeed] = membersOf(text);
        expect(text.slice(density.start, density.end)).toBe('Density = 3');
        expect(text.slice(crewSpeed.start, crewSpeed.end)).toBe('CrewSpeedFactor\n\t{\n\t\tForward = 1\n\t}');
        expect(density.key).toBe('density');
        expect(density.name).toBe('Density');
        expect(density.line).toBe(2);
    });

    it('reads a bare valueless field as a member of its own', () => {
        const [bare] = membersOf('Part\n{\n\tIsRotateable\n}\n');
        expect(bare.key).toBe('isrotateable');
        expect(bare.raw).toBe('IsRotateable');
    });
});
