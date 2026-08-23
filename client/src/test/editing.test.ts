import * as vscode from 'vscode';
import * as assert from 'assert';
import { activate, doc, editor, getDocUri, setTestContent } from './helper';

// The language configuration (`language-configuration.json`) is what makes a rules file behave like
// code while it is typed: quotes and brackets close themselves, and the comment shortcut knows the
// syntax. None of that is server-side, so only a real editor can tell whether it works. These tests
// type into the extension host and read back what the buffer holds, positive and negative alike: a
// pair that closes where it must, and one that stays a single character inside a string or comment,
// where an inserted partner would corrupt the value.
suite('Rules editing behavior', () => {
    const docUri = getDocUri('editing.rules');

    /**
     * Types `text` at `position` in the fixture and returns the line it landed on.
     *
     * @param content the buffer content to start from.
     * @param position where to put the caret before typing.
     * @param text the characters to type, one `type` command each.
     * @returns the text of the line the caret was on.
     */
    async function typeAt(content: string, position: vscode.Position, text: string): Promise<string> {
        await setTestContent(content);
        // A whole-document replace re-tokenizes asynchronously, and the pair the editor inserts is
        // decided from the token under the cursor, so typing before that settles reads as a string.
        await new Promise((resolve) => setTimeout(resolve, 300));
        editor.selection = new vscode.Selection(position, position);
        for (const character of text) {
            await vscode.commands.executeCommand('type', { text: character });
        }
        return doc.lineAt(position.line).text;
    }

    suiteSetup(async () => {
        await activate(docUri);
    });

    test('a quote at a value position closes itself', async () => {
        const line = await typeAt('Part\n{\n\tLayer = \n}\n', new vscode.Position(2, 10), '"');
        assert.strictEqual(line, '\tLayer = ""');
    });

    test('braces, brackets and a reference angle close themselves', async () => {
        assert.strictEqual(await typeAt('Part\n{\n\t\n}\n', new vscode.Position(2, 1), '{'), '\t{}');
        assert.strictEqual(await typeAt('Part\n{\n\t\n}\n', new vscode.Position(2, 1), '['), '\t[]');
        assert.strictEqual(await typeAt('Part\n{\n\tRef = &\n}\n', new vscode.Position(2, 8), '<'), '\tRef = &<>');
    });

    // The pair must not fire inside a string: a condition writes `>` and `<` as comparisons and an
    // asset path carries quotes of its own, so an inserted partner would land in the value.
    test('a quote inside a string stays a single character', async () => {
        const line = await typeAt('Part\n{\n\tNameKey = "Parts/Foo"\n}\n', new vscode.Position(2, 17), '"');
        assert.strictEqual(line, '\tNameKey = "Parts"/Foo"');
    });

    test('a comparison inside a string stays a single character', async () => {
        const before = '\tShowCondition = "? game.Fame  0"';
        const column = before.indexOf('  0') + 1;
        const line = await typeAt('Part\n{\n' + before + '\n}\n', new vscode.Position(2, column), '<');
        assert.strictEqual(line, before.slice(0, column) + '<' + before.slice(column));
    });

    test('a quote inside a comment stays a single character', async () => {
        const line = await typeAt('Part\n{\n\t// the layer is \n}\n', new vscode.Position(2, 18), '"');
        assert.strictEqual(line, '\t// the layer is "');
    });

    test('the comment shortcut knows the rules syntax', async () => {
        await setTestContent('Part\n{\n\tLayer = "roofs"\n}\n');
        editor.selection = new vscode.Selection(new vscode.Position(2, 4), new vscode.Position(2, 4));
        await vscode.commands.executeCommand('editor.action.commentLine');
        assert.strictEqual(doc.lineAt(2).text, '\t// Layer = "roofs"');
        await vscode.commands.executeCommand('editor.action.commentLine');
        assert.strictEqual(doc.lineAt(2).text, '\tLayer = "roofs"');
    });

    test('the block comment shortcut wraps the selection', async () => {
        await setTestContent('Part\n{\n\tLayer = "roofs"\n}\n');
        editor.selection = new vscode.Selection(new vscode.Position(2, 1), new vscode.Position(2, 16));
        await vscode.commands.executeCommand('editor.action.blockComment');
        // The editor pads the delimiters it inserts, which is its own convention, not the config's.
        assert.strictEqual(doc.lineAt(2).text, '\t/* Layer = "roofs" */');
    });

    // The one behavior the auto-closed quote exists to serve: with the pair in place the value is a
    // finished string, which is the shape the completion path resolves against.
    test('the closed pair leaves a value the completion path can read', async () => {
        await setTestContent('Part\n{\n\tSprite\n\t{\n\t\tLayer = \n\t}\n}\n');
        await new Promise((resolve) => setTimeout(resolve, 300));
        const position = new vscode.Position(4, 11);
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('type', { text: '"' });
        assert.strictEqual(doc.lineAt(4).text, '\t\tLayer = ""');
        assert.strictEqual(
            editor.selection.active.character,
            doc.lineAt(4).text.indexOf('"') + 1,
            'the caret sits between the quotes'
        );
    });
});
