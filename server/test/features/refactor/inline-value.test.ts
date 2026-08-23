import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, CodeAction } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { readFileSync } from 'fs';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { inlineValueCodeAction } from '../../../src/features/refactor/inline-value';
import { AbstractNodeDocument, ValueNode, isValueNode } from '../../../src/core/ast/ast';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { walkAst } from '../../helpers';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;
const URI = 'file:///inline.rules';

const parse = (source: string, uri = URI): AbstractNodeDocument => parser(lexer(source), uri).value;

/** The reference value node written exactly as `text`. */
const referenceNodeOf = (doc: AbstractNodeDocument, text: string): ValueNode => {
    for (const node of walkAst(doc)) {
        if (isValueNode(node) && node.valueType.type === 'Reference' && String(node.valueType.value) === text) {
            return node;
        }
    }
    throw new Error(`No reference ${text} in document`);
};

const actionAt = (source: string, reference: string, docUri = URI): Promise<CodeAction | undefined> => {
    const doc = parse(source, docUri);
    const node = referenceNodeOf(doc, reference);
    return inlineValueCodeAction(
        doc,
        source,
        { line: node.position.line, character: node.position.characterStart },
        docUri,
        token
    );
};

/** The text the single edit of an action writes. */
const inlinedText = (action: CodeAction | undefined, docUri = URI): string | undefined =>
    action?.edit?.changes?.[docUri]?.[0]?.newText;

/** The document as the action would leave it, which is what a user actually sees. */
const applied = (action: CodeAction | undefined, source: string, docUri = URI): string => {
    const edits = action?.edit?.changes?.[docUri];
    if (!edits) throw new Error('the action offered no edit');
    return TextDocument.applyEdits(TextDocument.create(docUri, 'rules', 0, source), edits);
};

/** The source text the single edit of an action covers, before anything is written over it. */
const replacedText = (action: CodeAction | undefined, source: string, docUri = URI): string => {
    const edits = action?.edit?.changes?.[docUri];
    if (!edits) throw new Error('the action offered no edit');
    const before = TextDocument.create(docUri, 'rules', 0, source);
    return source.slice(before.offsetAt(edits[0].range.start), before.offsetAt(edits[0].range.end));
};

// The inverse of the extract-value refactoring: a reference read once costs a reader a jump to learn
// one number, and the way back used to be copying the literal by hand.
describe('inlineValueCodeAction', () => {
    it('writes the literal the reference resolves to', async () => {
        const source = 'HEAT_MAX = 5\nPart\n{\n\tHeat = &~/HEAT_MAX\n}\n';
        const action = await actionAt(source, '&~/HEAT_MAX');
        expect(inlinedText(action)).toBe('5');
        expect(applied(action, source)).toBe('HEAT_MAX = 5\nPart\n{\n\tHeat = 5\n}\n');
        expect(action?.kind).toBe('refactor.inline');
    });

    it('covers the reference and nothing around it', async () => {
        // A range that reaches one character too far, or one that runs backwards, writes the value
        // over the text beside it, and the written value on its own cannot show that.
        const source = 'HEAT_MAX = 5\nPart\n{\n\tHeat = &~/HEAT_MAX\n}\n';
        const action = await actionAt(source, '&~/HEAT_MAX');
        expect(replacedText(action, source)).toBe('&~/HEAT_MAX');
    });

    it('leaves what follows the reference on the same line alone', async () => {
        // A comma ends a member, so the next assignment shares the line and sits right against the
        // range the edit replaces.
        const source = 'HEAT_MAX = 5\nPart\n{\n\tHeat = &~/HEAT_MAX, Other = 7\n}\n';
        const action = await actionAt(source, '&~/HEAT_MAX');
        expect(applied(action, source)).toBe('HEAT_MAX = 5\nPart\n{\n\tHeat = 5, Other = 7\n}\n');
    });

    it('keeps a suffixed number spelled the way its own file spells it', async () => {
        const source = 'ARC = 45d\nPart\n{\n\tFiringArc = &~/ARC\n}\n';
        const action = await actionAt(source, '&~/ARC');
        expect(inlinedText(action)).toBe('45d');
        expect(applied(action, source)).toBe('ARC = 45d\nPart\n{\n\tFiringArc = 45d\n}\n');
    });

    it('keeps the quotes of a quoted string', async () => {
        const source = 'LABEL = "Heavy Cannon"\nPart\n{\n\tName = &~/LABEL\n}\n';
        const action = await actionAt(source, '&~/LABEL');
        expect(inlinedText(action)).toBe('"Heavy Cannon"');
        expect(applied(action, source)).toBe('LABEL = "Heavy Cannon"\nPart\n{\n\tName = "Heavy Cannon"\n}\n');
    });

    it('refuses a target whose literal runs across a line break', async () => {
        // A `@"…"` string may hold real newlines, and writing one into the middle of a line would
        // hand the parser a member that ends somewhere the writer never chose.
        const source = 'TEXT = @"a\nb"\nPart\n{\n\tName = &~/TEXT\n}\n';
        expect(await actionAt(source, '&~/TEXT')).toBeUndefined();
    });

    it('refuses a target that is a group', async () => {
        const source = 'BLOCK\n{\n\tA = 1\n}\nPart\n{\n\tSub = &~/BLOCK\n}\n';
        expect(await actionAt(source, '&~/BLOCK')).toBeUndefined();
    });

    it('refuses a target whose own value is a runtime-rooted reference', async () => {
        // `~` is the root of wherever the rule is instantiated, so the walk hands that reference back
        // undereferenced rather than guessing, and writing the path itself would move its meaning.
        const source = 'A = 1\nALIAS = &~/A\nPart\n{\n\tHeat = &~/ALIAS\n}\n';
        expect(await actionAt(source, '&~/ALIAS')).toBeUndefined();
    });

    it('keeps a parenthesized reference balanced', async () => {
        // The math-group parse carries the closing paren inside the reference's own span, so the
        // replaced range has to stop before it or the line loses its bracket.
        const source = ['A = 5', 'Part', '{', '\tHeat = (&~/A) * 2', '}', ''].join('\n');
        expect(applied(await actionAt(source, '&~/A'), source)).toContain('Heat = (5) * 2');
    });

    it('keeps a function-call argument balanced', async () => {
        // The argument parse marks the reference parenthesized without extending its span, so the
        // same rule must not eat a character here.
        const source = ['A = 5', 'Part', '{', '\tHeat = ceil((&~/A) / 2)', '}', ''].join('\n');
        expect(applied(await actionAt(source, '&~/A'), source)).toContain('Heat = ceil((5) / 2)');
    });

    it('is offered with the caret on the closing paren the reference span covers', async () => {
        // The math-group parse puts the closing paren inside the reference's own span, so a caret
        // there still lands on the reference and has to leave the bracket standing.
        const line = '\tHeat = (&~/A) * 2';
        const source = ['A = 5', 'Part', '{', line, '}', ''].join('\n');
        const doc = parse(source);
        const action = await inlineValueCodeAction(doc, source, { line: 3, character: line.indexOf(')') }, URI, token);
        expect(applied(action, source)).toContain('Heat = (5) * 2');
    });

    it('writes the value in place for a plain reference', async () => {
        const source = ['A = 5', 'Part', '{', '\tHeat = &~/A', '}', ''].join('\n');
        expect(applied(await actionAt(source, '&~/A'), source)).toContain('Heat = 5');
    });

    const MANIFEST_SOURCE = [
        'A = 5',
        'Actions',
        '[',
        '\t{',
        '\t\tAction = Add',
        '\t\tToAdd = &~/A',
        '\t}',
        ']',
        '',
    ].join('\n');

    it('is not offered inside a manifest', async () => {
        // An action target resolves against the game install rather than against the file it is
        // written in, so what the editor resolves is not what an inline would mean.
        expect(await actionAt(MANIFEST_SOURCE, '&~/A', 'file:///c%3A/mod/mod.rules')).toBeUndefined();
    });

    it('is not offered inside a second manifest the game also loads', async () => {
        // The game loads `mod_*.rules` beside `mod.rules` as a manifest as well, so the refusal has
        // to hold for those names too.
        expect(await actionAt(MANIFEST_SOURCE, '&~/A', 'file:///c%3A/mod/mod_career.rules')).toBeUndefined();
    });

    it('is offered inside a hyphenated file, which the game loads as ordinary data', async () => {
        const dataUri = 'file:///c%3A/mod/mod-colors.rules';
        expect(inlinedText(await actionAt(MANIFEST_SOURCE, '&~/A', dataUri), dataUri)).toBe('5');
    });

    it('refuses a base written in an inheritance list', async () => {
        const source = 'Base\n{\n\tA = 1\n}\nDerived : &Base\n{\n\tB = 2\n}\n';
        expect(await actionAt(source, '&Base')).toBeUndefined();
    });

    it('is not offered on a value that is not a reference', async () => {
        const doc = parse('Part\n{\n\tHeat = 5\n}\n');
        const number = [...walkAst(doc)].find((node) => isValueNode(node) && node.valueType.value === 5) as ValueNode;
        const action = await inlineValueCodeAction(
            doc,
            'Part\n{\n\tHeat = 5\n}\n',
            { line: number.position.line, character: number.position.characterStart },
            URI,
            token
        );
        expect(action).toBeUndefined();
    });
});

describe('inlineValueCodeAction across files', () => {
    let source: string;
    let doc: AbstractNodeDocument;
    let uri: string;
    beforeAll(async () => {
        await initWorkspace();
        const path = workspaceFile('a.rules');
        source = readFileSync(path, 'utf8');
        uri = filePathToUri(path);
        doc = parse(source, uri);
    });

    const crossFileAction = (reference: string): Promise<CodeAction | undefined> => {
        const node = referenceNodeOf(doc, reference);
        return inlineValueCodeAction(
            doc,
            source,
            { line: node.position.line, character: node.position.characterStart },
            uri,
            token
        );
    };

    it('reads the literal out of the file the target lives in', async () => {
        const action = await crossFileAction('&<./Data/b.rules>/B/InnerValue');
        expect(action?.edit?.changes?.[uri]?.[0]?.newText).toBe('100');
    });

    it('follows a reference that names another reference to the value the game reads', async () => {
        const action = await crossFileAction('&<./Data/b.rules>/B/ToC');
        expect(action?.edit?.changes?.[uri]?.[0]?.newText).toBe('300');
    });

    it('refuses a target that is a whole group', async () => {
        expect(await crossFileAction('&<./Data/b.rules>/B')).toBeUndefined();
    });

    /** The action for a reference written in a source of this test's own, read under a.rules' uri. */
    const syntheticAction = (synthetic: string, reference: string, docUri = uri): Promise<CodeAction | undefined> => {
        const syntheticDoc = parse(synthetic, docUri);
        const node = referenceNodeOf(syntheticDoc, reference);
        return inlineValueCodeAction(
            syntheticDoc,
            synthetic,
            { line: node.position.line, character: node.position.characterStart },
            docUri,
            token
        );
    };

    const memberOf = (member: string): string =>
        `Part\n{\n\tAsset = &<./Data/effects/assets.rules>/Effect/${member}\n}\n`;

    it('rewrites an asset path against the folder the value lands in', async () => {
        // The game reads an asset path from the directory of the file it is written in, so a name
        // that stood next to effects/assets.rules has to grow the hop down from a.rules' own folder.
        const synthetic = memberOf('Icon');
        const action = await syntheticAction(synthetic, '&<./Data/effects/assets.rules>/Effect/Icon');
        expect(inlinedText(action, uri)).toBe('"effects/spark.png"');
    });

    it('rewrites an asset path that climbed out of its own folder', async () => {
        // `../sounds/fx/beep.wav` names the file by climbing out of effects, and from a.rules the
        // same file is one hop nearer, so the climb has to go.
        const synthetic = memberOf('Beep');
        const action = await syntheticAction(synthetic, '&<./Data/effects/assets.rules>/Effect/Beep');
        expect(inlinedText(action, uri)).toBe('"sounds/fx/beep.wav"');
    });

    it('refuses an asset path that names no file', async () => {
        // Nothing on disk answers to sparkk.png, so there is no way to show the moved path still
        // names what the original did.
        const synthetic = memberOf('Missing');
        expect(await syntheticAction(synthetic, '&<./Data/effects/assets.rules>/Effect/Missing')).toBeUndefined();
    });

    it('refuses a path read from the root of wherever the rule is instantiated', async () => {
        // `~` sends the game back to the declaring file's own root, so the same text picks a
        // different file once it is written somewhere else.
        const synthetic = 'ICON = "~/effects/spark.png"\nPart\n{\n\tSprite = &~/ICON\n}\n';
        expect(await syntheticAction(synthetic, '&~/ICON')).toBeUndefined();
    });

    it('writes an asset path out of the install in the form the game reads from its own folder', async () => {
        // A hop chain counted out of a mod folder names the install only on the machine the inline
        // was performed on, so a value leaving the game tree comes out as `./Data/…` instead.
        const modUri = filePathToUri(workspaceFile('..', 'workshop', 'om', 'om.rules'));
        const synthetic = memberOf('Icon');
        const action = await syntheticAction(synthetic, '&<./Data/effects/assets.rules>/Effect/Icon', modUri);
        expect(inlinedText(action, modUri)).toBe('"./Data/effects/spark.png"');
        expect(applied(action, synthetic, modUri)).toBe('Part\n{\n\tAsset = "./Data/effects/spark.png"\n}\n');
    });

    it('leaves an asset path alone when the value does not change folder', async () => {
        // The same path spelled without the root marker names the file from a.rules' folder already,
        // so the rewrite has nothing to do and the quotes come over untouched.
        const synthetic = 'ICON = "effects/spark.png"\nPart\n{\n\tSprite = &~/ICON\n}\n';
        const action = await syntheticAction(synthetic, '&~/ICON');
        expect(inlinedText(action, uri)).toBe('"effects/spark.png"');
    });
});
