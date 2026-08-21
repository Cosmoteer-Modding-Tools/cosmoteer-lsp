import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    CancellationToken,
    DocumentHighlight,
    DocumentHighlightKind,
    Location,
    Position,
    Range,
} from 'vscode-languageserver';
import { readFile } from 'fs/promises';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AbstractNodeDocument } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import {
    clearDocumentHighlightCache,
    documentHighlightsAt,
} from '../../../src/features/navigation/document-highlight';
import { ReferenceIndex, referenceNodesOf } from '../../../src/features/navigation/reference-index';
import { stringValueNodesOf } from '../../../src/features/navigation/schema-reference.navigation';
import { normalizeUri } from '../../../src/features/navigation/reference-location';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const FOLDERS = [WORKSPACE_DATA_DIR];

/** Ask for the highlights at a position, with the workspace treated as settled and no memoization. */
const highlightsAt = (document: AbstractNodeDocument, position: Position): Promise<DocumentHighlight[] | null> =>
    documentHighlightsAt(document, position, true, undefined, token);

/** The position of `needle` on the first line of `source` containing `line`, offset into the needle. */
const positionOf = (source: string, line: string, needle: string, offset = 1): Position => {
    const lines = source.split('\n');
    const index = lines.findIndex((candidate) => candidate.includes(line));
    if (index < 0) throw new Error(`line not found: ${line}`);
    const character = lines[index].indexOf(needle, lines[index].indexOf(line));
    if (character < 0) throw new Error(`needle not found: ${needle}`);
    return { line: index, character: character + offset };
};

/** True when the inner range sits inside the outer one, both being single-line. */
const within = (outer: Range, inner: Range): boolean =>
    outer.start.line === inner.start.line &&
    outer.start.character <= inner.start.character &&
    outer.end.character >= inner.end.character;

/** The highlight ranges as compact strings, so an expectation reads as text rather than as objects. */
const rangeTexts = (highlights: DocumentHighlight[] | null, source: string): string[] =>
    (highlights ?? []).map((highlight) => {
        const line = source.split('\n')[highlight.range.start.line] ?? '';
        return line.slice(highlight.range.start.character, highlight.range.end.character);
    });

// A minimal particle effect: a writer in EmitterDef, readers and writers in Def. The same shape the
// channel navigation tests use, so both features are pinned against one file.
const PARTICLE_SRC = `Type = Particles
Def
{
\tUpdaters
\t[
\t\t{
\t\t\tType = SetRandom
\t\t\tDataOut = rot_vel
\t\t\tValueType = Angle
\t\t}
\t\t{
\t\t\tType = Operator
\t\t\tAIn = rot
\t\t\tBIn = rot_vel
\t\t\tResultOut = rot
\t\t}
\t]
}
EmitterDef
{
\tPreInitializers
\t[
\t\t{
\t\t\tType = SetValue
\t\t\tDataOut = rot_vel
\t\t}
\t]
}
`;

// A part whose `ResourceType` and `Resources` entries are both `ID<ResourceRules>` references, one of
// them spelled with a capital the game ignores when it matches ids.
const PART_SRC = `Part
{
\tResources
\t[
\t\t[Battery, 20]
\t]
\tComponents
\t{
\t\tStore { Type = ResourceStorage; ResourceType = battery }
\t}
}
`;

// A whole-file-rooted resource: its top-level `ID` is the declaration every `ResourceType = battery`
// in the project points at.
const RESOURCE_SRC = `ID = battery
NameKey = "Resources/Battery"
SellPrice = 10
`;

const parse = (source: string, uri: string): AbstractNodeDocument => parser(lexer(source), uri).value;

describe('documentHighlight: particle data channels', () => {
    const document = () => parse(PARTICLE_SRC, 'file:///mod/effects/effect.rules');

    it('lights up every occurrence of the channel, writers as writes and readers as reads', async () => {
        const highlights = await highlightsAt(document(), positionOf(PARTICLE_SRC, 'DataOut = rot_vel', 'rot_vel'));

        expect(highlights).toHaveLength(3);
        expect(rangeTexts(highlights, PARTICLE_SRC)).toEqual(['rot_vel', 'rot_vel', 'rot_vel']);
        expect(highlights!.map((highlight) => highlight.kind)).toEqual([
            DocumentHighlightKind.Write,
            DocumentHighlightKind.Read,
            DocumentHighlightKind.Write,
        ]);
    });

    it('answers the same from a reader as from a writer, the relation being symmetric', async () => {
        const fromWriter = await highlightsAt(document(), positionOf(PARTICLE_SRC, 'DataOut = rot_vel', 'rot_vel'));
        const fromReader = await highlightsAt(document(), positionOf(PARTICLE_SRC, 'BIn = rot_vel', 'rot_vel'));

        expect(fromReader).toEqual(fromWriter);
    });

    it('separates two channels in the same group', async () => {
        const highlights = await highlightsAt(document(), positionOf(PARTICLE_SRC, 'AIn = rot', 'rot'));

        expect(highlights).toHaveLength(2);
        expect(highlights!.map((highlight) => highlight.kind)).toEqual([
            DocumentHighlightKind.Read,
            DocumentHighlightKind.Write,
        ]);
    });
});

describe('documentHighlight: positions the server has no answer for', () => {
    const document = () => parse(PARTICLE_SRC, 'file:///mod/effects/effect.rules');

    // Both editors keep a word matcher behind the language server and use it whenever the server
    // answers null, so an empty list would take away highlighting the reader has today.
    it('answers null and never an empty list on an enum value', async () => {
        const highlights = await highlightsAt(document(), positionOf(PARTICLE_SRC, 'ValueType = Angle', 'Angle'));

        expect(highlights).toBeNull();
        expect(highlights).not.toEqual([]);
    });

    it('answers null on a bare number, on empty space and past the end of a line', async () => {
        const source = 'A\n{\n\tDamage = 12\n}\n';
        const document = parse(source, 'file:///mod/parts/plain.rules');

        expect(await highlightsAt(document, positionOf(source, 'Damage = 12', '12'))).toBeNull();
        expect(await highlightsAt(document, { line: 2, character: 0 })).toBeNull();
        expect(await highlightsAt(document, { line: 2, character: 400 })).toBeNull();
        expect(await highlightsAt(document, { line: 99, character: 0 })).toBeNull();
    });

    it('answers null inside a comment', async () => {
        const source = 'A\n{\n\t// Damage is doubled here\n\tDamage = 12\n}\n';
        const document = parse(source, 'file:///mod/parts/commented.rules');

        expect(await highlightsAt(document, positionOf(source, '// Damage', 'Damage'))).toBeNull();
    });

    it('declines a .shader document, whose word matching the editor already does', async () => {
        const document = parse('float4 Tint = 1;\n', 'file:///mod/shaders/tint.shader');

        expect(await highlightsAt(document, { line: 0, character: 8 })).toBeNull();
    });
});

describe('documentHighlight: cross-file ids, answered without touching the disk', () => {
    it('lights up every use of an id in the file, matching case the way the game does', async () => {
        const document = parse(PART_SRC, 'file:///mod/parts/store.rules');
        const highlights = await highlightsAt(document, positionOf(PART_SRC, 'ResourceType = battery', 'battery'));

        expect(rangeTexts(highlights, PART_SRC).sort()).toEqual(['Battery', 'battery']);
        expect(highlights!.every((highlight) => highlight.kind === DocumentHighlightKind.Read)).toBe(true);
    });

    it('answers the same from the differently cased use', async () => {
        const document = parse(PART_SRC, 'file:///mod/parts/store.rules');
        const fromLower = await highlightsAt(document, positionOf(PART_SRC, 'ResourceType = battery', 'battery'));
        const fromUpper = await highlightsAt(document, positionOf(PART_SRC, '[Battery, 20]', 'Battery'));

        expect(fromUpper).toEqual(fromLower);
    });

    it('reads a whole-file root id declaration as a write', async () => {
        const document = parse(RESOURCE_SRC, 'file:///mod/resources/battery.rules');
        const highlights = await highlightsAt(document, positionOf(RESOURCE_SRC, 'ID = battery', 'battery'));

        expect(highlights).toHaveLength(1);
        expect(highlights![0].kind).toBe(DocumentHighlightKind.Write);
        expect(rangeTexts(highlights, RESOURCE_SRC)).toEqual(['battery']);
    });
});

describe('documentHighlight: references within one document', () => {
    let repeated: AbstractNodeDocument;
    let repeatedSrc: string;
    let aDoc: AbstractNodeDocument;
    let aSrc: string;

    beforeAll(async () => {
        await initWorkspace();
        repeatedSrc = await readFile(workspaceFile('repeated-refs.rules'), 'utf8');
        aSrc = await readFile(workspaceFile('a.rules'), 'utf8');
        repeated = await parseFilePath(workspaceFile('repeated-refs.rules'));
        aDoc = await parseFilePath(workspaceFile('a.rules'));
    });

    it('lights up the declaration and every reference to it', async () => {
        const highlights = await highlightsAt(repeated, positionOf(repeatedSrc, '\tV = 1', 'V'));

        expect(highlights).toHaveLength(4);
        expect(rangeTexts(highlights, repeatedSrc)).toEqual(['V', 'V', 'V', 'V']);
        expect(highlights!.filter((highlight) => highlight.kind === DocumentHighlightKind.Write)).toHaveLength(1);
        expect(highlights!.filter((highlight) => highlight.kind === DocumentHighlightKind.Read)).toHaveLength(3);
    });

    it('answers the same from a reference as from the declaration', async () => {
        const fromDeclaration = await highlightsAt(repeated, positionOf(repeatedSrc, '\tV = 1', 'V'));
        const fromReference = await highlightsAt(repeated, positionOf(repeatedSrc, 'R2 = &~/MemoBase/V', '/V', 1));

        expect(fromReference).toEqual(fromDeclaration);
    });

    it('lights up the segment under the cursor, not the whole reference path', async () => {
        const highlights = await highlightsAt(repeated, positionOf(repeatedSrc, 'R2 = &~/MemoBase/V', 'MemoBase'));

        expect(rangeTexts(highlights, repeatedSrc)).toEqual(['MemoBase', 'MemoBase', 'MemoBase', 'MemoBase']);
        expect(highlights!.filter((highlight) => highlight.kind === DocumentHighlightKind.Write)).toHaveLength(1);
    });

    it('lights up a name used mid-path as well as at the end of a path', async () => {
        // Three of a.rules' references cross into `B` on their way somewhere else, and one names it
        // outright. All four spell the same group, so all four are occurrences of it.
        const highlights = await highlightsAt(aDoc, positionOf(aSrc, 'RefToB = &<./Data/b.rules>/B', 'b.rules>/B', 9));

        expect(rangeTexts(highlights, aSrc)).toEqual(['B', 'B', 'B', 'B']);
    });

    it('stays inside the document the cursor is in, the protocol asking for one file', async () => {
        const highlights = await highlightsAt(aDoc, positionOf(aSrc, 'ToB = &<./Data/b.rules>/B/InnerValue', 'InnerValue'));

        expect(rangeTexts(highlights, aSrc)).toEqual(['InnerValue']);
        // `InnerValue` is declared in b.rules, so the declaration is not part of this file's answer.
        expect(highlights!.every((highlight) => highlight.kind === DocumentHighlightKind.Read)).toBe(true);
    });

    it('holds back the resolving branch until the project scan has settled', async () => {
        const notReady = await documentHighlightsAt(
            repeated,
            positionOf(repeatedSrc, '\tV = 1', 'V'),
            false,
            undefined,
            token
        );

        expect(notReady).toBeNull();
    });
});

describe('documentHighlight: agrees with find-all-references, restricted to the document', () => {
    let documents: Map<string, { document: AbstractNodeDocument; source: string }>;

    beforeAll(async () => {
        await initWorkspace();
        documents = new Map();
        for (const name of ['a.rules', 'b.rules', 'base.rules', 'repeated-refs.rules']) {
            documents.set(name, {
                document: await parseFilePath(workspaceFile(name)),
                source: await readFile(workspaceFile(name), 'utf8'),
            });
        }
    });

    const cases: Array<{ file: string; line: string; needle: string }> = [
        { file: 'repeated-refs.rules', line: '\tV = 1', needle: 'V' },
        { file: 'repeated-refs.rules', line: 'R1 = &~/MemoBase/V', needle: '/V' },
        { file: 'b.rules', line: 'InnerValue = 100', needle: 'InnerValue' },
        { file: 'b.rules', line: 'B', needle: 'B' },
        { file: 'b.rules', line: 'ToC = &<./Data/c.rules>/C/Leaf', needle: 'Leaf' },
        { file: 'a.rules', line: 'ToB = &<./Data/b.rules>/B/InnerValue', needle: 'InnerValue' },
        { file: 'a.rules', line: 'RefToB = &<./Data/b.rules>/B', needle: 'b.rules>/B' },
        { file: 'base.rules', line: 'Base', needle: 'Base' },
    ];

    for (const testCase of cases) {
        it(`${testCase.file} at ${testCase.needle.trim()} matches the reference search`, async () => {
            const entry = documents.get(testCase.file)!;
            const needleOffset = testCase.needle.length - 1;
            const position = positionOf(entry.source, testCase.line, testCase.needle, needleOffset);
            const highlights = (await highlightsAt(entry.document, position)) ?? [];
            const references = await ReferenceIndex.instance.findReferences(
                entry.document,
                position,
                false,
                FOLDERS,
                token
            );
            const local = references.filter(
                (reference: Location) => normalizeUri(reference.uri) === normalizeUri(entry.document.uri)
            );
            const uses = highlights.filter((highlight) => highlight.kind === DocumentHighlightKind.Read);

            // Every site the reference search reports in this file is highlighted. A highlight covers
            // the name inside the reference while the search reports the whole value, so the highlight
            // sits within the reported site.
            for (const reference of local) {
                expect(uses.some((use) => within(reference.range, use.range))).toBe(true);
            }
            // And nothing is invented: every highlight sits on a reference value the document has.
            const values = [...referenceNodesOf(entry.document), ...stringValueNodesOf(entry.document)];
            for (const use of uses) {
                expect(
                    values.some((value) =>
                        within(
                            {
                                start: { line: value.position.line, character: value.position.characterStart },
                                end: { line: value.position.line, character: value.position.characterEnd },
                            },
                            use.range
                        )
                    )
                ).toBe(true);
            }
        });
    }
});

describe('documentHighlight: memoization', () => {
    let repeated: AbstractNodeDocument;
    let repeatedSrc: string;

    beforeAll(async () => {
        await initWorkspace();
        repeatedSrc = await readFile(workspaceFile('repeated-refs.rules'), 'utf8');
        repeated = await parseFilePath(workspaceFile('repeated-refs.rules'));
    });

    beforeEach(() => clearDocumentHighlightCache());

    it('answers a repeated request for one buffer version from the memo', async () => {
        const position = positionOf(repeatedSrc, '\tV = 1', 'V');
        const first = await documentHighlightsAt(repeated, position, true, 7, token);
        const second = await documentHighlightsAt(repeated, position, true, 7, token);

        expect(second).toBe(first);
    });

    it('recomputes after the buffer changes', async () => {
        const position = positionOf(repeatedSrc, '\tV = 1', 'V');
        const first = await documentHighlightsAt(repeated, position, true, 7, token);
        const afterEdit = await documentHighlightsAt(repeated, position, true, 8, token);

        expect(afterEdit).not.toBe(first);
        expect(afterEdit).toEqual(first);
    });

    it('recomputes after the cache is dropped for the document', async () => {
        const position = positionOf(repeatedSrc, '\tV = 1', 'V');
        const first = await documentHighlightsAt(repeated, position, true, 7, token);
        clearDocumentHighlightCache(repeated.uri);
        const second = await documentHighlightsAt(repeated, position, true, 7, token);

        expect(second).not.toBe(first);
        expect(second).toEqual(first);
    });

    it('caches nothing when the caller has no buffer version', async () => {
        const position = positionOf(repeatedSrc, '\tV = 1', 'V');
        const first = await documentHighlightsAt(repeated, position, true, undefined, token);
        const second = await documentHighlightsAt(repeated, position, true, undefined, token);

        expect(second).not.toBe(first);
        expect(second).toEqual(first);
    });
});

describe('documentHighlight: malformed documents', () => {
    // A document mid-edit is the normal case for a feature that runs on every cursor move, so a
    // half-written member, an unbalanced brace or a deeply nested file must answer rather than throw.
    const sources = [
        'A\n{\n\tKey =\n}\n',
        'A\n{\n\tKey = &\n',
        'Broken { { { ]]] "unterminated\n',
        '&&&\n//\n;;;,,,\n',
        `${'A {'.repeat(300)}\n${'}'.repeat(300)}\n`,
        'Type = Particles\nDef\n{\n\tUpdaters\n\t[\n\t\t{ DataOut = }\n\t]\n}\n',
    ];

    it('never throws and never answers an empty list', async () => {
        for (const source of sources) {
            const document = parse(source, 'file:///mod/parts/broken.rules');
            const lines = source.split('\n');
            for (let line = 0; line < lines.length; line++) {
                for (let character = 0; character <= lines[line].length; character++) {
                    const highlights = await highlightsAt(document, { line, character });
                    expect(highlights === null || highlights.length > 0).toBe(true);
                }
            }
        }
    });
});

describe('documentHighlight: keystroke budget', () => {
    // Occurrence highlighting runs on every cursor move, so the cost of the worst shape in the corpus
    // (a part file repeating one reference in hundreds of separate containers, each resolved on its
    // own) is pinned. The budget is deliberately loose: it is there to catch a lost memo or an
    // accidental project-wide sweep, not to measure the machine.
    const HEAVY_SRC = [
        'Base',
        '{',
        '\tV = 1',
        '}',
        ...Array.from({ length: 300 }, (_, index) => `User${index}\n{\n\tRef = &~/Base/V\n}`),
        '',
    ].join('\n');

    it('answers a heavy document well inside a keystroke', async () => {
        await initWorkspace();
        const document = parse(HEAVY_SRC, 'file:///mod/parts/heavy.rules');
        const position = positionOf(HEAVY_SRC, '\tV = 1', 'V');
        const timings: number[] = [];
        for (let run = 0; run < 5; run++) {
            const started = performance.now();
            const highlights = await documentHighlightsAt(document, position, true, undefined, token);
            timings.push(performance.now() - started);
            expect(highlights).toHaveLength(301);
        }
        timings.sort((a, b) => a - b);

        expect(timings[timings.length - 1]).toBeLessThan(300);
    });
});
