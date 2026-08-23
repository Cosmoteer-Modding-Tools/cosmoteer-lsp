import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Position } from 'vscode-languageserver';
import { readFileSync } from 'fs';
import { HoverService } from '../../../src/features/hover/hover.service';
import { AbstractNodeDocument, isAssignmentNode } from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { walkAst } from '../../helpers';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

/** Position over the key of the `name = …` assignment. */
const keyPosition = (doc: AbstractNodeDocument, name: string): Position => {
    for (const node of walkAst(doc)) {
        if (isAssignmentNode(node) && node.left.name === name) {
            const position = node.left.position;
            return Position.create(position.line, position.characterStart + 1);
        }
    }
    throw new Error(`assignment ${name} not found`);
};

const hoverOf = async (doc: AbstractNodeDocument, name: string): Promise<string> => {
    const hover = await HoverService.instance.getHover(doc, keyPosition(doc, name), token);
    if (!hover) return '';
    return (hover.contents as { value: string }).value;
};

const inlineHover = (source: string, name: string): Promise<string> =>
    hoverOf(parser(lexer(source), 'file:///inline.rules').value, name);

// A reference that works out to a number is answered by the evaluator. The rest used to say only
// what kind of thing they point at, so following one meant opening the file it names.
describe('hover preview of a reference target', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('shows a list target with its entries', async () => {
        const text = await inlineHover(['Rect', '[', '\t0, 1, 2, 1', ']', 'Ref = &Rect'].join('\n'), 'Ref');
        expect(text).toContain('list `Rect` `[0, 1, 2, 1]`');
    });

    it('shows a group target with its own fields', async () => {
        const text = await inlineHover(['Shield', '{', '\tRadius = 13', '}', 'Ref = &Shield'].join('\n'), 'Ref');
        expect(text).toContain('group `Shield` `{Radius = 13}`');
    });

    it('names a container inside the preview rather than nesting it', async () => {
        const source = ['Outer', '{', '\tInner', '\t{', '\t\tA = 1', '\t}', '}', 'Ref = &Outer'].join('\n');
        expect(await inlineHover(source, 'Ref')).toContain('group `Outer` `{{…}}`');
    });

    it('shows the group a cross-file reference points at', async () => {
        const path = workspaceFile('a.rules');
        const document = parser(lexer(readFileSync(path, 'utf8')), filePathToUri(path)).value;
        // `RefToB` names a group inside another file, `ToB` a member of it.
        const text = await hoverOf(document, 'RefToB');
        expect(text).toContain('group `B`');
    });

    it('names the file a whole-file reference points at', async () => {
        // The game roots a `<…>` reference at the install folder, so this names b.rules itself
        // rather than any node in it. That is the third target shape, and the one the hover used to
        // skip outright.
        const text = await inlineHover('WholeB = &<./Data/b.rules>', 'WholeB');
        expect(text).toContain('the file `b.rules`');
    });

    it('still shows a scalar target as its written value', async () => {
        const text = await inlineHover(['ICON = ui/icon.png', 'Ref = &ICON'].join('\n'), 'Ref');
        expect(text).toContain('`ui/icon.png`');
    });

    // A weapon's frame list or a long path can run past the width of the hover, and the preview is
    // one line by contract, so both are cut with an ellipsis rather than wrapped.
    it('cuts a long list target to twelve entries', async () => {
        const nums = Array.from({ length: 20 }, (_, index) => index).join(', ');
        const text = await inlineHover(['Nums', '[', nums, ']', 'Ref = &Nums'].join('\n'), 'Ref');
        expect(text).toContain('list `Nums` `[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, …]`');
    });

    it('cuts a long written value to sixty characters', async () => {
        const text = await inlineHover([`LONG = ${'ab'.repeat(50)}`, 'Ref = &LONG'].join('\n'), 'Ref');
        expect(text).toContain(`\`${'ab'.repeat(30)}…\``);
    });

    // An empty group is a real shape in the game's files, a slot a mod fills later. Naming it is
    // useful, showing it an empty body is not.
    it('names an empty group without inventing a body', async () => {
        const text = await inlineHover(['Empty', '{', '}', 'Ref = &Empty'].join('\n'), 'Ref');
        expect(text).toContain('group `Empty`');
        expect(text).not.toContain('{}');
    });

    it('names an empty list without inventing a body', async () => {
        const text = await inlineHover(['Empty', '[', ']', 'Ref = &Empty'].join('\n'), 'Ref');
        expect(text).toContain('list `Empty`');
        expect(text).not.toContain('[]');
    });

    // A list element has no name of its own, so an empty one has neither name nor body and keeps
    // the placeholder the hover has always shown.
    it('keeps the placeholder for an anonymous container with nothing in it', async () => {
        const source = ['Outer', '[', '\t{ }', ']', 'Ref = &Outer/0'].join('\n');
        expect(await inlineHover(source, 'Ref')).toContain('group `{ … }`');
    });

    it('previews an anonymous container by its body', async () => {
        const source = ['Outer', '[', '\t{ A = 1 }', ']', 'Ref = &Outer/0'].join('\n');
        expect(await inlineHover(source, 'Ref')).toContain('group `{A = 1}`');
    });

    // A rect or a frame list written inside a group is the other half of the nesting rule the group
    // case above covers, and it carries its own shape.
    it('names a list inside the preview by its shape', async () => {
        const source = ['Outer', '{', '\tInner', '\t[', '\t\t1, 2', '\t]', '}', 'Ref = &Outer'].join('\n');
        expect(await inlineHover(source, 'Ref')).toContain('group `Outer` `{[…]}`');
    });

    it('previews an anonymous list by its entries', async () => {
        const source = ['Outer', '[', '\t[ 1, 2 ]', ']', 'Ref = &Outer/0'].join('\n');
        expect(await inlineHover(source, 'Ref')).toContain('list `[1, 2]`');
    });

    it('keeps the placeholder for an anonymous list with nothing in it', async () => {
        const source = ['Outer', '[', '\t[ ]', ']', 'Ref = &Outer/0'].join('\n');
        expect(await inlineHover(source, 'Ref')).toContain('list `[ … ]`');
    });

    // A member written with no value is one the game reads by name, so the name is what the preview
    // has to show for it.
    it('names a member written without a value', async () => {
        const source = ['Outer', '{', '\tFlag', '\tA = 1', '}', 'Ref = &Outer'].join('\n');
        expect(await inlineHover(source, 'Ref')).toContain('group `Outer` `{Flag, A = 1}`');
    });
});
