/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode';
import * as path from 'path';

export let doc: vscode.TextDocument;
export let editor: vscode.TextEditor;
export let documentEol: string;
export let platformEol: string;

/**
 * Activates the extension and opens the given document so its language features are available.
 *
 * @param docUri the URI of the document to open.
 * @param timeout milliseconds to wait after opening for the server to initialize.
 */
export async function activate(docUri: vscode.Uri, timeout = 2_000) {
    // The extensionId is `publisher.name` from package.json
    const ext = vscode.extensions.getExtension('TrustNoOneElse.cosmoteer-language-server');
    if (!ext) return;
    if (!ext.isActive) {
        await ext.activate();
    }
    try {
        doc = await vscode.workspace.openTextDocument(docUri);
        editor = await vscode.window.showTextDocument(doc);
        await sleep(timeout); // Wait for init
    } catch (e) {
        console.error(e);
    }
}

async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const getDocPath = (p: string) => {
    return path.resolve(__dirname, '../../client/testFixture', p);
};
export const getDocUri = (p: string) => {
    return vscode.Uri.file(getDocPath(p));
};

export async function setTestContent(content: string): Promise<boolean> {
    const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    return editor.edit((eb) => eb.replace(all, content));
}
