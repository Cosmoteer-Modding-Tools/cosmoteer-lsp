/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode';
import * as assert from 'assert';
import { getDocUri, activate } from './helper';

suite('Should do completion', () => {
    const docUri = getDocUri('completion.rules');

    // `Ref = &TestBase/Value` references into `TestBase`, whose members are
    // `ValueOne`/`ValueTwo`. Completing the partial `Value` segment must offer both.
    test('Completes reference members in a rules file', async () => {
        await testCompletion(docUri, new vscode.Position(4, 10), ['ValueOne', 'ValueTwo']);
    });

    // The post-snippet state of the component-name completion: a fresh component block whose
    // `Type = ` value is still empty. The discriminator list must arrive through the real client.
    test('Completes the Type discriminator at an empty value position', async () => {
        await testCompletion(getDocUri('part_type.rules'), new vscode.Position(7, 10), ['MultiToggle'], false);
    });
});

async function testCompletion(
    docUri: vscode.Uri,
    position: vscode.Position,
    expectedLabels: string[],
    expectReferenceKind = true
) {
    await activate(docUri);

    // Executing the command `vscode.executeCompletionItemProvider` to simulate triggering completion
    const actualCompletionList = (await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        docUri,
        position
    )) as vscode.CompletionList;

    const actualLabels = actualCompletionList.items.map((item) =>
        typeof item.label === 'string' ? item.label : item.label.label
    );
    expectedLabels.forEach((label) => {
        assert.ok(
            actualLabels.includes(label),
            `expected completion '${label}' in [${actualLabels.join(', ')}]`
        );
        if (!expectReferenceKind) return;
        const item = actualCompletionList.items.find(
            (i) => (typeof i.label === 'string' ? i.label : i.label.label) === label
        )!;
        assert.equal(item.kind, vscode.CompletionItemKind.Reference);
    });
}
