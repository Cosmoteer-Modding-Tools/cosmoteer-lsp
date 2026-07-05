import { describe, expect, it } from 'vitest';
import { Location, Range } from 'vscode-languageserver';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { computeDocumentLinks, linkTargetFromLocation } from '../../../src/features/navigation/document-links';

const parse = (src: string) => parser(lexer(src), 'file:///t.rules').value;

describe('computeDocumentLinks', () => {
    it('produces a link for a reference value and an asset value', () => {
        const doc = parse('Part\n{\n\tParent = &Base\n\tIcon = icon.png\n}');
        const links = computeDocumentLinks(doc);
        // one for &Base (reference), one for icon.png (asset)
        expect(links.length).toBe(2);
        for (const link of links) {
            expect(link.target).toBeUndefined(); // resolved lazily
            expect(link.data).toMatchObject({ uri: 'file:///t.rules' });
            // range is a non-empty single-line span
            expect(link.range.start.line).toBe(link.range.end.line);
            expect(link.range.end.character).toBeGreaterThan(link.range.start.character);
        }
    });

    it('splits a multi-segment reference into per-segment links with cumulative prefixes', () => {
        const doc = parse('Part\n{\n\tRef = &<foo.rules>/A/B\n}');
        const links = computeDocumentLinks(doc);
        const prefixes = links.map((l) => (l.data as { prefix?: string }).prefix);
        expect(prefixes).toContain('&<foo.rules>');
        expect(prefixes).toContain('&<foo.rules>/A');
        expect(prefixes).toContain('&<foo.rules>/A/B');
        // ranges tile left-to-right without overlap
        const ranges = links.map((l) => l.range).sort((a, b) => a.start.character - b.start.character);
        for (let i = 1; i < ranges.length; i++) {
            expect(ranges[i].start.character).toBeGreaterThanOrEqual(ranges[i - 1].end.character);
        }
        // only the last segment is resolved through full go-to-definition
        expect(links.filter((l) => (l.data as { isFull: boolean }).isFull).length).toBe(1);
    });

    it('links inheritance references too', () => {
        const doc = parse('Child : Base\n{\n\tX = 1\n}');
        const links = computeDocumentLinks(doc);
        expect(links.length).toBeGreaterThanOrEqual(1);
    });

    it('produces no links for a document with no references or assets', () => {
        const doc = parse('Part\n{\n\tHealth = 100\n\tName = "hi"\n}');
        expect(computeDocumentLinks(doc)).toEqual([]);
    });
});

describe('linkTargetFromLocation', () => {
    it('links to the bare file for a whole-file (zero-range) target', () => {
        const loc: Location = { uri: 'file:///x.rules', range: Range.create(0, 0, 0, 0) };
        expect(linkTargetFromLocation(loc)).toBe('file:///x.rules');
    });

    it('encodes a member position as a 1-based #L fragment', () => {
        const loc: Location = { uri: 'file:///x.rules', range: Range.create(4, 2, 4, 9) };
        expect(linkTargetFromLocation(loc)).toBe('file:///x.rules#L5,3');
    });
});
