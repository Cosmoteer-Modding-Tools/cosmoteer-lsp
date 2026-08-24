import { beforeAll, describe, expect, it } from 'vitest';
import { CodeAction } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import { makeModifiableCodeActions } from '../../../src/features/refactor/make-modifiable';
import { plainTextOf } from '../../../src/features/refactor/snippet-action';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { setGlobalSettings, globalSettings } from '../../../src/settings';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

const PART_PATH = workspaceFile('parts', 'modifiable_part.rules');
const URI = filePathToUri(PART_PATH);

const source = (value: string): string =>
    [
        'Part',
        '{',
        '\tID = test_part',
        '\tComponents',
        '\t{',
        '\t\tthruster',
        '\t\t{',
        '\t\t\tType = Thruster',
        `\t\t\tForce = ${value}`,
        '\t\t}',
        '\t}',
        '}',
        '',
    ].join('\n');

/** The actions offered where `needle` is written, which is where a user would put the caret. */
const actionsAt = (text: string, needle: string): CodeAction[] => {
    const document = TextDocument.create(URI, 'rules', 0, text);
    const parsed = parser(lexer(text), PART_PATH).value;
    const offset = text.indexOf(needle);
    if (offset < 0) throw new Error(`no ${needle} in the document`);
    return makeModifiableCodeActions(parsed, document, offset, URI);
};

/** The document as the offer would leave it, read through the plain form of its snippet. */
const applied = (action: CodeAction, text: string): string => {
    const args = action.command?.arguments?.[0] as
        | { range: { start: { line: number; character: number }; end: { line: number; character: number } }; snippet: string }
        | undefined;
    const document = TextDocument.create(URI, 'rules', 0, text);
    if (args) return TextDocument.applyEdits(document, [{ range: args.range, newText: plainTextOf(args.snippet) }]);
    const edits = action.edit?.changes?.[URI];
    if (!edits) throw new Error('the action offered neither a snippet nor an edit');
    return TextDocument.applyEdits(document, edits);
};

// The group form is what the game reads at a modifiable slot, and writing it by hand means knowing
// which of the class's twelve optional members carry the value. The offer writes the two that do.
describe('make a value modifiable', () => {
    beforeAll(async () => {
        await initWorkspace();
        setGlobalSettings({ ...globalSettings, allowEditingVanillaFiles: true });
    });

    it('wraps a plain number in the group form the game also reads', () => {
        const text = source('4.5');
        const [action] = actionsAt(text, 'Force');
        expect(action?.title).toContain('Force');
        expect(applied(action, text)).toContain('Force\n\t\t\t{\n\t\t\t\tBaseValue = 4.5');
    });

    it('leaves the modifiers list empty, since every modifier names something that has to exist', () => {
        const text = source('4.5');
        const [action] = actionsAt(text, 'Force');
        const result = applied(action, text);
        expect(result).toContain('Modifiers\n\t\t\t\t[\n\t\t\t\t\t\n\t\t\t\t]');
    });

    it('keeps the value spelled the way the file writes it', () => {
        const text = source('(&~/THRUST)');
        const [action] = actionsAt(text, 'Force');
        expect(applied(action, text)).toContain('BaseValue = (&~/THRUST)');
    });

    it('is not offered on a field the game reads only as a plain number', () => {
        const text = source('4.5').replace('Force = 4.5', 'Force = 4.5\n\t\t\tResourceStorage = fuel');
        expect(actionsAt(text, 'ResourceStorage')).toHaveLength(0);
    });

    it('collapses a group that carries nothing but its base value', () => {
        const text = source('4.5').replace(
            '\t\t\tForce = 4.5',
            ['\t\t\tForce', '\t\t\t{', '\t\t\t\tBaseValue = 4.5', '\t\t\t}'].join('\n')
        );
        const [action] = actionsAt(text, 'BaseValue');
        expect(applied(action, text)).toContain('Force = 4.5');
    });

    it('leaves a group carrying a bound alone, since the bound changes what the game computes', () => {
        const text = source('4.5').replace(
            '\t\t\tForce = 4.5',
            ['\t\t\tForce', '\t\t\t{', '\t\t\t\tBaseValue = 4.5', '\t\t\t\tMaxValue = 9', '\t\t\t}'].join('\n')
        );
        expect(actionsAt(text, 'BaseValue')).toHaveLength(0);
    });
});

// The plain form is what a client that cannot place a tab stop gets, so it has to be the same text
// minus the stops rather than the snippet body written out.
describe('the plain form of a snippet', () => {
    it('drops a bare tab stop', () => {
        expect(plainTextOf('Modifiers [ $0 ]')).toBe('Modifiers [  ]');
    });

    it('writes a placeholder as its default', () => {
        expect(plainTextOf('Type = ${1:Buff}')).toBe('Type = Buff');
    });

    it('writes a choice as its first option', () => {
        expect(plainTextOf('Type = ${1|Buff,Status,EffectScale|}')).toBe('Type = Buff');
    });

    it('unescapes what the snippet syntax made the author escape', () => {
        expect(plainTextOf('BaseValue = (&~/A) \\$1')).toBe('BaseValue = (&~/A) $1');
    });
});
