import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, Position } from 'vscode-languageserver';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HoverService } from '../../../src/features/hover/hover.service';
import {
    AbstractNodeDocument,
    GroupNode,
    IdentifierNode,
    isAssignmentNode,
    isGroupNode,
    isIdentifierNode,
    isListNode,
} from '../../../src/core/ast/ast';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { globalSettings } from '../../../src/settings';
import { FIXTURES_DIR, walkAst } from '../../helpers';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const token = CancellationToken.None;

/** The group of that name, wherever it sits in the document. */
const groupNamed = (doc: AbstractNodeDocument, name: string): GroupNode => {
    for (const node of walkAst(doc)) {
        if (isGroupNode(node) && node.identifier?.name === name) return node;
    }
    throw new Error(`group ${name} not found`);
};

/** Position over the key of `member = …` inside one named group, since the same name is written in
 *  several groups of these sources. */
const keyPositionIn = (doc: AbstractNodeDocument, group: string, member: string): Position => {
    for (const element of groupNamed(doc, group).elements) {
        if (isAssignmentNode(element) && element.left.name === member) {
            const position = element.left.position;
            return Position.create(position.line, position.characterStart + 1);
        }
    }
    throw new Error(`assignment ${member} not found in ${group}`);
};

/** Position over a group's own name. */
const namePositionOf = (doc: AbstractNodeDocument, group: string): Position => {
    const position = groupNamed(doc, group).identifier!.position;
    return Position.create(position.line, position.characterStart + 1);
};

/** Position over the name a member carries itself: a group- or list-form member, or a bare key with
 *  no value. None of those is an assignment, so `keyPositionIn` cannot reach them. */
const memberNamePositionIn = (group: GroupNode, member: string): Position => {
    for (const element of group.elements) {
        let identifier: IdentifierNode | undefined | null;
        if (isGroupNode(element) || isListNode(element)) identifier = element.identifier;
        else if (isIdentifierNode(element)) identifier = element;
        if (identifier?.name !== member) continue;
        return Position.create(identifier.position.line, identifier.position.characterStart + 1);
    }
    throw new Error(`member ${member} not found in ${group.identifier?.name}`);
};

const hoverAt = async (doc: AbstractNodeDocument, position: Position): Promise<string> => {
    const hover = await HoverService.instance.getHover(doc, position, token);
    if (!hover) return '';
    return (hover.contents as { value: string }).value;
};

const parseInline = (source: string): AbstractNodeDocument => parser(lexer(source), 'file:///inline.rules').value;

/** A file read from disk under its own uri, so the `&<…>` bases it names resolve. */
const parseFile = (path: string): AbstractNodeDocument =>
    parser(lexer(readFileSync(path, 'utf8')), filePathToUri(path)).value;

/** A file of the inheritance-chain fixture, which sits outside the game tree because each of its
 *  files exists only to add one more base file to a chain. */
const chainFixture = (name: string): AbstractNodeDocument => parseFile(join(FIXTURES_DIR, 'provenance-chain', name));

const SAME_FILE = `Base
{
	CombineMode = Add
	BaseValue = 0%
}

Derived : Base
{
	BaseValue = 50%
	Exponent = 3
}
`;

const COMPUTED = `Base
{
	CombineMode = Add
	BaseValue = 1 + 2
}

Derived : Base
{
	BaseValue = 50%
	Exponent = 3
}
`;

const NESTED = `BaseOuter
{
	Sub
	{
		A = 9
	}
}

Outer : BaseOuter
{
	Deep
	{
		A = 1
		B = 2
	}

	Sub : Deep
	{
		A = 2
	}
}
`;

const SHAPES = `Base
{
	Items
	[
		1, 2
	]
	Flag
	Sub
	{
		A = 1
	}
}

Derived : Base
{
	Items
	[
		3, 4
	]
	Flag
	Sub
	{
		B = 2
	}
}
`;

// A file shows one level of a chain. The value a member replaces is written in a base the reader has
// to open by hand, and nothing in the editor said so before.
describe('hover provenance', () => {
    let sameFile: AbstractNodeDocument;
    let crossFile: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        sameFile = parseInline(SAME_FILE);
        crossFile = parseFile(workspaceFile('a.rules'));
    });

    afterEach(() => {
        globalSettings.hover.showProvenance = true;
    });

    it('names the declaration a member replaces, by line alone inside one file', async () => {
        const text = await hoverAt(sameFile, keyPositionIn(sameFile, 'Derived', 'BaseValue'));
        expect(text).toContain('Replaces');
        expect(text).toContain('on line 4');
    });

    it('says nothing over a member the chain does not write', async () => {
        const text = await hoverAt(sameFile, keyPositionIn(sameFile, 'Derived', 'Exponent'));
        expect(text).not.toContain('Replaces');
    });

    it('says nothing over a member of a group that inherits nothing', async () => {
        const text = await hoverAt(sameFile, keyPositionIn(sameFile, 'Base', 'BaseValue'));
        expect(text).not.toContain('Replaces');
    });

    it('sums up what a group takes from its bases, and how much of it is written again', async () => {
        const text = await hoverAt(sameFile, namePositionOf(sameFile, 'Derived'));
        expect(text).toContain('Its bases supply 2 fields');
        expect(text).toContain('1 of them are written here as well.');
    });

    it('names the file a cross-file base is written in', async () => {
        const text = await hoverAt(crossFile, namePositionOf(crossFile, 'AChild'));
        expect(text).toContain('Its bases supply 2 fields');
        expect(text).toContain('base.rules');
        expect(text).not.toContain('are written here as well');
    });

    it('names the file and line of a base the reader would have to open', async () => {
        const derivedPart = parseFile(workspaceFile('parts', 'derived_part.rules'));
        const text = await hoverAt(derivedPart, keyPositionIn(derivedPart, 'IsOperational', 'Mode'));
        // `Mode = All` is written in base_part.rules, so a bare line number would send the reader
        // looking in the wrong file.
        expect(text).toContain('Replaces `All` in base_part.rules:12');
        expect(text).not.toContain('on line');
    });

    it('places a computed declaration by line without quoting it', async () => {
        const computed = parseInline(COMPUTED);
        const text = await hoverAt(computed, keyPositionIn(computed, 'Derived', 'BaseValue'));
        // The base writes `1 + 2`, which the game works out as it loads, so the only honest thing to
        // say about that declaration is where it stands.
        expect(text).toContain('Replaces the declaration on line 4');
        expect(text).not.toContain('Replaces `');
    });

    it('places a computed declaration in another file by file and line', async () => {
        const derived = chainFixture('computed_derived.rules');
        const text = await hoverAt(derived, keyPositionIn(derived, 'MathDerived', 'Computed'));
        expect(text).toContain('Replaces the declaration in computed_base.rules:5');
        expect(text).not.toContain('Replaces `');
    });

    it('names both what a nested group replaces and what it inherits', async () => {
        const nested = parseInline(NESTED);
        // A group's own name is a member of its parent and a container in its turn, so both
        // sentences can be true of it at once.
        const text = await hoverAt(nested, memberNamePositionIn(groupNamed(nested, 'Outer'), 'Sub'));
        const paragraphs = text.split('\n\n');
        expect(paragraphs).toHaveLength(2);
        expect(paragraphs[0]).toContain('Replaces *group of 1* on line 3');
        expect(paragraphs[1]).toContain('Its bases supply 2 fields');
    });

    it('names the list a list-form member replaces', async () => {
        const shapes = parseInline(SHAPES);
        // `Items [ … ]` carries its name on the list itself, with no `=` and so no sibling
        // assignment to read the name off.
        const text = await hoverAt(shapes, memberNamePositionIn(groupNamed(shapes, 'Derived'), 'Items'));
        expect(text).toContain('Replaces *list of 2* on line 3');
    });

    it('names the declaration a bare key replaces', async () => {
        const shapes = parseInline(SHAPES);
        // A key written with no value at all is still a member the game reads, and it parses to a
        // standalone identifier.
        const text = await hoverAt(shapes, memberNamePositionIn(groupNamed(shapes, 'Derived'), 'Flag'));
        expect(text).toContain('Replaces *(no value)* on line 7');
    });

    it('names the group a group-form member replaces', async () => {
        const shapes = parseInline(SHAPES);
        const text = await hoverAt(shapes, memberNamePositionIn(groupNamed(shapes, 'Derived'), 'Sub'));
        expect(text).toContain('Replaces *group of 1* on line 8');
    });

    it('folds the base files past the third into an ellipsis', async () => {
        const chain = chainFixture('chain5.rules');
        const text = await hoverAt(chain, namePositionOf(chain, 'Chain5'));
        expect(text).toContain('Its bases supply 4 fields');
        // Which three files get named follows the order the chain walk hands them back in, so the
        // count and the fold are what the test pins.
        expect(text).toMatch(/from (`[^`]+\.rules`, ){3}…\./);
    });

    it('is silent when the setting is off', async () => {
        globalSettings.hover.showProvenance = false;
        const text = await hoverAt(sameFile, keyPositionIn(sameFile, 'Derived', 'BaseValue'));
        expect(text).not.toContain('Replaces');
    });
});
