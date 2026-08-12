import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lexer } from '../../../src/core/lexer/lexer';
import { parser } from '../../../src/core/parser/parser';
import {
    EXTRACT_LOCALIZATION_KEY_ACTION_COMMAND,
    ExtractLocalizationKeyArgs,
    buildExtractLocalizationKeyEdit,
    extractLocalizationKeyCodeAction,
} from '../../../src/features/refactor/extract-localization-key';
import { initWorkspace, workspaceFile } from '../../workspace-helper';
import { filePathToUri } from '../../../src/features/navigation/navigation-strategy';
import { resolve } from 'path';

const token = CancellationToken.None;

/** The code action offered at the caret marked by `|`, using a real file of the fixture mod. */
const actionAt = async (source: string, fsPath: string) => {
    const offset = source.indexOf('|');
    const text = source.replace('|', '');
    const uri = filePathToUri(fsPath);
    const document = parser(lexer(text), uri).value;
    const doc = TextDocument.create(uri, 'rules', 1, text);
    return extractLocalizationKeyCodeAction(document, text, doc.positionAt(offset), uri, [], token);
};

// The refactoring only fires on display text sitting in a localization-key field. A value that already
// looks like a key path belongs to the missing-key quick fix instead, and a field that is not a
// KeyString is none of its business.
describe('extractLocalizationKeyCodeAction', () => {
    let partFile: string;

    beforeAll(async () => {
        await initWorkspace();
        partFile = workspaceFile('a.rules');
    });

    it('does not offer on a value that is already key-path shaped', async () => {
        expect(await actionAt('Part\n{\n\tNameKey = "Pa|rts/Foo"\n}\n', partFile)).toBeUndefined();
    });

    it('does not offer on a field that is not a localization key', async () => {
        expect(await actionAt('Part\n{\n\tSomeText = "He|llo there"\n}\n', partFile)).toBeUndefined();
    });

    it('does not offer on an unquoted value', async () => {
        expect(await actionAt('Part\n{\n\tNameKey = He|llo\n}\n', partFile)).toBeUndefined();
    });

    it('offers on display text in a key field, inside a mod that ships a language file', async () => {
        // The fixture mod declares `StringsFolder = "strings"` and ships strings/en.rules, which is
        // what gives the extraction somewhere to write.
        const inMod = resolve(__dirname, '../../fixtures/reachability-mod/wired/a.rules');
        const action = await actionAt('Part\n{\n\tNameKey = "He|llo there"\n}\n', inMod);
        expect(action).toBeDefined();
        expect(action?.kind).toBe('refactor.extract');
        // The command is the one the server leaves unclaimed, so the client can ask for the key.
        expect(action?.command?.command).toBe(EXTRACT_LOCALIZATION_KEY_ACTION_COMMAND);
        const args = action?.command?.arguments?.[0] as ExtractLocalizationKeyArgs;
        expect(args.literal).toBe('"Hello there"');
        // No sibling key to follow and no group path to learn from, so the key is named after the file.
        expect(args.key).toBe('A');
    });

    it('does not offer when the mod ships no language file', async () => {
        // a.rules of the plain fixture workspace is not inside a mod with a strings folder.
        expect(await actionAt('Part\n{\n\tNameKey = "He|llo there"\n}\n', partFile)).toBeUndefined();
    });
});

describe('buildExtractLocalizationKeyEdit', () => {
    beforeAll(async () => {
        await initWorkspace();
    });

    it('refuses when the literal is no longer where the offer said', async () => {
        const text = 'Part\n{\n\tNameKey = "Hello there"\n}\n';
        const uri = filePathToUri(workspaceFile('a.rules'));
        const doc = TextDocument.create(uri, 'rules', 1, text);
        const args: ExtractLocalizationKeyArgs = {
            uri,
            // Deliberately the wrong offset, standing in for a buffer that moved on.
            offset: 0,
            literal: '"Hello there"',
            key: 'Parts/Hello',
        };
        const plan = await buildExtractLocalizationKeyEdit(args, doc, token);
        expect(plan.failure).toBe('stale');
        expect(plan.edit).toBeUndefined();
    });

    it('writes the literal into the language file and points the field at the key', async () => {
        const inMod = resolve(__dirname, '../../fixtures/reachability-mod/wired/a.rules');
        const uri = filePathToUri(inMod);
        const text = 'Part\n{\n\tNameKey = "Hello there"\n}\n';
        const doc = TextDocument.create(uri, 'rules', 1, text);
        const plan = await buildExtractLocalizationKeyEdit(
            { uri, offset: text.indexOf('"Hello there"'), literal: '"Hello there"', key: 'Parts/Hello' },
            doc,
            token
        );
        expect(plan.failure).toBeUndefined();
        const changes = plan.edit?.changes ?? {};
        // The source value now names the key.
        expect(changes[uri]?.map((edit) => edit.newText)).toEqual(['"Parts/Hello"']);
        // The mod's one language file gains the key, carrying the literal rather than an empty
        // placeholder, so nothing the player sees changes until somebody translates it.
        const stringsUri = Object.keys(changes).find((key) => key.endsWith('strings/en.rules'));
        expect(stringsUri).toBeDefined();
        expect(changes[stringsUri!][0].newText).toContain('"Hello there"');
        expect(changes[stringsUri!][0].newText).toContain('Hello');
        expect(plan.changedFiles).toHaveLength(1);
    });

    it('refuses an empty key rather than writing a nameless member', async () => {
        const text = 'Part\n{\n\tNameKey = "Hello there"\n}\n';
        const uri = filePathToUri(workspaceFile('a.rules'));
        const doc = TextDocument.create(uri, 'rules', 1, text);
        const plan = await buildExtractLocalizationKeyEdit(
            { uri, offset: text.indexOf('"Hello there"'), literal: '"Hello there"', key: '   ' },
            doc,
            token
        );
        expect(plan.failure).toBe('stale');
    });
});

describe('the action carries a command rather than an edit', () => {
    it('names the client command the server leaves unclaimed', () => {
        // The key path is the author's to name, and only the editor can ask for one. The server not
        // declaring this id is what makes the client resolve it.
        expect(EXTRACT_LOCALIZATION_KEY_ACTION_COMMAND).toBe('cosmoteer.extractLocalizationKeyFromAction');
    });
});
