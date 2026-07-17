import { beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'url';
import { CancellationToken } from 'vscode-languageserver';
import { ValidationForIdentifier, ValidationForValue } from '../../../src/features/diagnostics/validator.value';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { AstPosition, IdentifierNode, ValueNode } from '../../../src/core/ast/ast';
import { findReferenceNode, walkAst } from '../../helpers';
import { globalSettings } from '../../../src/settings';
import { initWorkspace, workspaceFile, WORKSPACE_DATA_DIR } from '../../workspace-helper';

const token = CancellationToken.None;
const pos = (): AstPosition => ({ line: 0, characterStart: 0, characterEnd: 0, start: 0, end: 0 });
const run = (node: ValueNode) => ValidationForValue.callback(node, token);

describe('value diagnostics: parentheses and assets (node-level)', () => {
    it('flags a parenthesized plain value', async () => {
        const node: ValueNode = { type: 'Value', valueType: { type: 'String', value: 'x' }, parenthesized: true, position: pos() };
        const error = await run(node);
        expect(error?.message).toBe('Value should not be parenthesized');
        expect(error?.additionalInfo).toBe('References in function calls need to be parenthesized or math expressions');
    });

    it('does not flag a parenthesized number (valid math grouping)', async () => {
        const node: ValueNode = { type: 'Value', valueType: { type: 'Number', value: 1 }, parenthesized: true, position: pos() };
        expect(await run(node)).toBeUndefined();
    });

    it('flags an unquoted asset path that contains whitespace, as a warning', async () => {
        // The game loads simple unquoted paths fine. Only a path with whitespace is genuinely
        // ambiguous unquoted, so only that is flagged, and as a warning, not a hard error.
        const node: ValueNode = { type: 'Value', valueType: { type: 'Sprite', value: 'foo bar.png' }, quoted: false, position: pos() };
        const error = await run(node);
        expect(error?.message).toBe('Asset paths should be quoted');
        expect(error?.additionalInfo).toBe('Assets should be quoted with ""');
        expect(error?.severity).toBe('warning');
        expect(error?.data?.quickFix?.newText).toBe('"foo bar.png"');
    });

    it('does NOT flag a simple unquoted asset path (the game accepts it)', async () => {
        // `File = foo.png` (no whitespace) is valid unquoted. It must not be a quoting error.
        const node: ValueNode = { type: 'Value', valueType: { type: 'Sprite', value: 'foo.png' }, quoted: false, position: pos() };
        const error = await run(node);
        expect(error?.message).not.toBe('Asset paths should be quoted');
    });
});

describe('value diagnostics: references (parsed)', () => {
    const validate = async (src: string, reference: string) => {
        const doc = parser(lexer(src), 'file:///refs.rules').value;
        return run(findReferenceNode(doc, reference));
    };

    it('flags a syntactically invalid reference', async () => {
        const error = await validate('Bad = &~has~tilde\n', '&~has~tilde');
        expect(error?.message).toBe('Reference is not valid');
        expect(error?.additionalInfo).toContain('<>, ..');
    });

    it('flags a reference whose name resolves to nothing, as a warning (game tolerates it)', async () => {
        const error = await validate('Root = 1\nBad = &DoesNotExist\n', '&DoesNotExist');
        expect(error?.message).toBe('Reference name is not known');
        expect(error?.additionalInfo).toContain('an identifier that is not in scope');
        expect(error?.severity).toBe('warning');
    });

    it('does not flag a reference that resolves in the same file', async () => {
        const error = await validate('Root = 1\nGood = &Root\n', '&Root');
        expect(error).toBeUndefined();
    });
});

const validateIdentifier = async (src: string, name: string, uri = 'file:///bare-refs.rules') => {
    const doc = parser(lexer(src), uri).value;
    for (const node of walkAst(doc)) {
        if (node.type === 'Identifier' && (node as IdentifierNode).name === name) {
            return ValidationForIdentifier.callback(node as IdentifierNode, token);
        }
    }
    throw new Error(`No identifier node found for "${name}"`);
};

// The bare reference elements sit after a `{ }` sibling on purpose: only then does the parser
// classify them as IdentifierNodes (after `[` or a value sibling they parse as ValueNodes and
// the regular value check covers them). Group and document positions are a parse error instead
// (the game rejects a bare reference there), see parser.list-bare-reference.test.ts.
describe('identifier diagnostics: bare reference list elements (parsed)', () => {
    it('flags a bare list reference that resolves to nothing, as a warning', async () => {
        const error = await validateIdentifier('List\n[\n\t{\n\t\tX = 1\n\t}\n\t&NoSuchThing\n]\n', '&NoSuchThing');
        expect(error?.message).toBe('Reference name is not known');
        expect(error?.severity).toBe('warning');
        expect((error?.node as IdentifierNode)?.name).toBe('&NoSuchThing');
    });

    it('does not flag a bare non-reference identifier (void field)', async () => {
        const error = await validateIdentifier('Group\n{\n\tSomeFlag\n}\n', 'SomeFlag');
        expect(error).toBeUndefined();
    });

    it('does not flag a bare runtime-rooted reference element', async () => {
        const error = await validateIdentifier(
            'List\n[\n\t{\n\t\tX = 1\n\t}\n\t&~/Runtime/Thing\n]\n',
            '&~/Runtime/Thing'
        );
        expect(error).toBeUndefined();
    });
});

// `Name { … }` on ONE line inside a list: the game reads the whole line as one text element (a
// listed value does not stop at `{`), so the name and body never exist in game. The name parses
// as a String value (after `[` or a value sibling) or as an identifier (after a `}` sibling),
// so both callbacks carry the check.
describe('list element name joined with its body on one line', () => {
    const firstError = async (src: string) => {
        const doc = parser(lexer(src), 'file:///joined.rules').value;
        for (const node of walkAst(doc)) {
            if (node.type === 'Value') {
                const error = await ValidationForValue.callback(node as ValueNode, token);
                if (error) return error;
            }
            if (node.type === 'Identifier') {
                const error = await ValidationForIdentifier.callback(node as IdentifierNode, token);
                if (error) return error;
            }
        }
        return undefined;
    };

    it('flags a name and brace on one line (name parsed as value)', async () => {
        const error = await firstError('L\n[\n\tFoo { X = 1 }\n]\n');
        expect(error?.message).toBe('The game reads this whole line as one text element');
        expect(error?.severity).toBe('warning');
        expect(error?.data?.quickFix?.title).toBe("Remove 'Foo'");
        expect(error?.data?.quickFix?.newText).toBe('');
    });

    it('flags a name and brace on one line after a group sibling (name parsed as identifier)', async () => {
        const error = await firstError('L\n[\n\t{\n\t\tA = 1\n\t}\n\tFoo { X = 1 }\n]\n');
        expect(error?.message).toBe('The game reads this whole line as one text element');
        expect(error?.data?.quickFix?.title).toBe("Remove 'Foo'");
    });

    it('flags a name and bracket body on one line', async () => {
        const error = await firstError('L\n[\n\tFoo [ 1, 2 ]\n]\n');
        expect(error?.message).toBe('The game reads this whole line as one text element');
    });

    it('does not flag a comma-separated name before a body (two legal elements, the vanilla Toggles idiom)', async () => {
        const error = await firstError('Toggles = [ IsOperational, { Toggle = IsOverclocked; Invert = true } ]\n');
        expect(error?.message).not.toBe('The game reads this whole line as one text element');
    });

    it('does not flag a semicolon-separated name before a body', async () => {
        const error = await firstError('L\n[\n\tFoo; { X = 1 }\n]\n');
        expect(error?.message).not.toBe('The game reads this whole line as one text element');
    });

    it('does not flag when the body opens on the next line (game: text element + anonymous element)', async () => {
        const error = await firstError('L\n[\n\tFoo\n\t{\n\t\tX = 1\n\t}\n]\n');
        expect(error?.message).not.toBe('The game reads this whole line as one text element');
    });

    it('does not flag a named group inside a GROUP (normal and legal)', async () => {
        const error = await firstError('G\n{\n\tFoo { X = 1 }\n}\n');
        expect(error?.message).not.toBe('The game reads this whole line as one text element');
    });

    it('does not flag a plain string element without a following body', async () => {
        const error = await firstError('L\n[\n\tFoo\n\tBar\n]\n');
        expect(error?.message).not.toBe('The game reads this whole line as one text element');
    });
});

// Keep this suite LAST in the file: it initializes the singleton workspace service, which
// stays initialized for every test that runs after it in this worker.
describe('identifier diagnostics: bare super-path list elements against the fixture workspace', () => {
    const uri = pathToFileURL(workspaceFile('bare_ref_probe.rules')).href;

    beforeAll(async () => {
        await initWorkspace();
        globalSettings.cosmoteerPath = WORKSPACE_DATA_DIR;
    });

    it('does not flag a bare `&/…` element that resolves in the workspace root', async () => {
        const error = await validateIdentifier(
            'List\n[\n\t{\n\t\tX = 1\n\t}\n\t&/Palette/Main\n]\n',
            '&/Palette/Main',
            uri
        );
        expect(error).toBeUndefined();
    });

    it('flags a bare `&/…` element whose root member does not exist, as a warning', async () => {
        const error = await validateIdentifier(
            'List\n[\n\t{\n\t\tX = 1\n\t}\n\t&/PARTICLES/DoesNotExist\n]\n',
            '&/PARTICLES/DoesNotExist',
            uri
        );
        expect(error?.message).toBe('Reference name is not known');
        expect(error?.severity).toBe('warning');
    });
});
