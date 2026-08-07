import { describe, expect, it } from 'vitest';
import { BlockCommentSpan, lexer } from '../../../src/core/lexer/lexer';
import {
    validateOrphanCommentTerminators,
    validateUnclosedComments,
    validateUnterminatedComments,
} from '../../../src/features/diagnostics/validator.comment';

const findings = (src: string) => {
    const blockComments: BlockCommentSpan[] = [];
    lexer(src, blockComments);
    return validateUnclosedComments(src, blockComments);
};

const unterminated = (src: string) => {
    const blockComments: BlockCommentSpan[] = [];
    lexer(src, blockComments);
    return validateUnterminatedComments(src, blockComments);
};

const orphans = (src: string) => validateOrphanCommentTerminators(lexer(src));

describe('block comments the game never closes', () => {
    it.each(['/**/', '/* x */', '/** x */', '/*** x */', '/* x ***/', '/****/'])(
        'accepts %s, whose closing star run is odd',
        (comment) => {
            expect(findings(`A = 1\n${comment}\nB = 2`)).toHaveLength(0);
        }
    );

    it.each(['/***/', '/* x **/', '/** x **/', '/******** x ********/'])(
        'flags %s, whose closing star run is even',
        (comment) => {
            const result = findings(`A = 1\n${comment}\nB = 2`);
            expect(result).toHaveLength(1);
            expect(result[0].severity).toBe('warning');
        }
    );

    it('flags a comment inside a group', () => {
        expect(findings('Part {\n\tComponents {\n\t\t/*** off **/\n\t}\n}')).toHaveLength(1);
    });

    it('flags every banner comment of a file', () => {
        expect(findings('/**** A ****/\nX = 1\n/**** B ****/\nY = 2')).toHaveLength(2);
    });

    it('leaves an unterminated comment alone, it has no closing run', () => {
        expect(findings('A = 1\n/*** never ends')).toHaveLength(0);
    });

    it('leaves a comment shape inside a string alone', () => {
        expect(findings('A = "/*** x **/"')).toHaveLength(0);
    });

    it('anchors the finding to the closing star run', () => {
        const src = 'A = 1\n/** x **/\nB = 2';
        const [finding] = findings(src);
        expect(src.slice(finding.node.position.start, finding.node.position.end)).toBe('**/');
        expect(finding.node.position.line).toBe(1);
    });

    it('offers a fix that drops one star from the closing run', () => {
        const src = '/******** SECTION ********/';
        const [finding] = findings(src);
        expect(finding.data?.quickFix?.newText).toBe('*******/');
        const fixed =
            src.slice(0, finding.node.position.start) +
            finding.data!.quickFix!.newText +
            src.slice(finding.node.position.end);
        expect(fixed).toBe('/******** SECTION *******/');
        expect(findings(fixed)).toHaveLength(0);
    });

    it('leaves the second "*/" of a file alone, that is the orphan check below', () => {
        expect(findings('/* a */\nX = 1\n*/\n')).toHaveLength(0);
    });

    it('closes a bare /***/ with the same fix', () => {
        const src = 'A = 1\n/***/\nB = 2';
        const [finding] = findings(src);
        expect(finding.data?.quickFix?.newText).toBe('*/');
        const fixed =
            src.slice(0, finding.node.position.start) +
            finding.data!.quickFix!.newText +
            src.slice(finding.node.position.end);
        expect(fixed).toBe('A = 1\n/**/\nB = 2');
        expect(findings(fixed)).toHaveLength(0);
    });
});

// A block comment that no `*/` ends runs to the end of the file, where the game throws. Our lexer
// takes the end of the file as the end of the comment, so everything it swallowed simply vanishes.
describe('block comments that never close', () => {
    it('flags a comment the file ends inside (hypermatter_reactor_4x4 Fusionv1.rules)', () => {
        const result = unterminated('/* //TWO VARIATIONS BACKED UP\nPart\n{\n\tA = 1\n}\n');
        expect(result).toHaveLength(1);
        expect(result[0].message).toBe('This comment is never closed');
    });

    it('anchors the finding to the opening slash star', () => {
        const src = 'A = 1\n/* never ends';
        const [finding] = unterminated(src);
        expect(src.slice(finding.node.position.start, finding.node.position.end)).toBe('/*');
    });

    it('accepts a closed comment', () => {
        expect(unterminated('/* a */\nA = 1\n')).toHaveLength(0);
    });

    it('accepts a comment shape inside a string', () => {
        expect(unterminated('A = "/* not a comment"\n')).toHaveLength(0);
    });

    it('accepts a line comment holding a slash star', () => {
        expect(unterminated('// /* just a note\nA = 1\n')).toHaveLength(0);
    });
});

// Block comments do not nest and a `//` inside one does not hide its `*/`, so a second `*/` is read
// as rules content and the game throws on it.
describe('a "*/" that closes no comment', () => {
    it('flags the second terminator of a nested comment attempt (dpmexplosive_struct_nuke.rules)', () => {
        const result = orphans('/*\n\tA = 1\n\t/*\n\t\tB = 2\n\t*/\n\tC = 3\n*/\nD = 4\n');
        expect(result).toHaveLength(1);
        expect(result[0].message).toBe('This "*/" closes no comment');
    });

    it('anchors the finding to the stray terminator', () => {
        const src = '/* a */\nX = 1\n*/\nY = 2\n';
        const [finding] = orphans(src);
        expect(src.slice(finding.node.position.start, finding.node.position.end)).toBe('*/');
    });

    it('accepts a single closed comment', () => {
        expect(orphans('/* a */\nX = 1\n')).toHaveLength(0);
    });

    it('accepts comments that close one after another', () => {
        expect(orphans('/* a */\nX = 1\n/* b */\nY = 2\n')).toHaveLength(0);
    });

    it('accepts a division that follows a multiplication mid value', () => {
        expect(orphans('X = 2 * (&A) / 4\n')).toHaveLength(0);
    });

    it('accepts a terminator inside a string', () => {
        expect(orphans('X = "*/"\n')).toHaveLength(0);
    });
});
