import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, WorkspaceEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { prepareRename, rename } from '../../../src/features/navigation/rename.service';
import { AbstractNodeDocument, isGroupNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { walkAst } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// A reference written in quotes is stored without them, so the span of the value is two characters
// wider than the text it carries. Lining the two up by hand used to fail, and the rename then wrote
// the new name over the whole quoted value, delimiters and path included.
const token = CancellationToken.None;

let root = '';
let folders: string[] = [];
let particles: AbstractNodeDocument;
let part: AbstractNodeDocument;

const PART_SOURCE = 'Part\n{\n\tQuoted = "&<particles.rules>/PARTICLES/Foo"\n}\n';

/**
 * The text a file is left with once the rename's edits are applied to it.
 *
 * @param edit the rename's workspace edit.
 * @param fileName the file to apply, by its base name.
 * @returns the file's text after the edits.
 */
const applied = (edit: WorkspaceEdit | null, fileName: string): string => {
    const entry = Object.entries(edit?.changes ?? {}).find(([uri]) => decodeURIComponent(uri).endsWith(fileName));
    const source = readFileSync(join(root, fileName), 'utf8');
    if (!entry) return source;
    return TextDocument.applyEdits(TextDocument.create(entry[0], 'rules', 1, source), entry[1]);
};

const declarationCaret = (document: AbstractNodeDocument, name: string) => {
    for (const node of walkAst(document)) {
        if (isGroupNode(node) && node.identifier?.name === name) {
            return { line: node.identifier.position.line, character: node.identifier.position.characterStart };
        }
    }
    throw new Error(`group ${name} not found`);
};

describe('renaming through a reference written in quotes', () => {
    beforeAll(async () => {
        await initWorkspace();
        root = mkdtempSync(join(tmpdir(), 'cosmoteer-quoted-ref-'));
        writeFileSync(join(root, 'particles.rules'), 'PARTICLES\n{\n\tFoo\n\t{\n\t\tA = 1\n\t}\n}\n');
        writeFileSync(join(root, 'part.rules'), PART_SOURCE);
        folders = [pathToFileURL(root).href];
        particles = await parseFilePath(join(root, 'particles.rules'));
        part = await parseFilePath(join(root, 'part.rules'));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('rewrites only the name inside the quotes when the declaration is renamed', async () => {
        const edit = await rename(particles, declarationCaret(particles, 'Foo'), 'Bar', folders, token);
        expect(applied(edit, 'part.rules')).toBe('Part\n{\n\tQuoted = "&<particles.rules>/PARTICLES/Bar"\n}\n');
        expect(applied(edit, 'particles.rules')).toBe('PARTICLES\n{\n\tBar\n\t{\n\t\tA = 1\n\t}\n}\n');
    });

    it('offers the name inside the quotes and rewrites it from the reference itself', async () => {
        const line = 2;
        const character = PART_SOURCE.split('\n')[line].indexOf('Foo');
        const prepared = await prepareRename(part, { line, character }, token);
        expect(prepared).toEqual({
            range: { start: { line, character }, end: { line, character: character + 3 } },
            placeholder: 'Foo',
        });
        const edit = await rename(part, { line, character }, 'Bar', folders, token);
        expect(applied(edit, 'part.rules')).toBe('Part\n{\n\tQuoted = "&<particles.rules>/PARTICLES/Bar"\n}\n');
    });
});
