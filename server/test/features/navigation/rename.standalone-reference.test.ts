import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { RenameService } from '../../../src/features/navigation/rename.service';
import { AbstractNodeDocument, isGroupNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { walkAst } from '../../helpers';
import { initWorkspace } from '../../workspace-helper';

// A bare `&…` list element is an IdentifierNode rather than a ValueNode whenever the element before
// it is not a value, which is what a `{ … }` element leaves behind. It is a reference the game reads
// like any other, so renaming what it names has to rewrite it, from either end of the rename.
const token = CancellationToken.None;
const service = RenameService.instance;

let root = '';
let folders: string[] = [];
let particles: AbstractNodeDocument;
let part: AbstractNodeDocument;

const groupIdentifier = (document: AbstractNodeDocument, name: string) => {
    for (const node of walkAst(document)) if (isGroupNode(node) && node.identifier?.name === name) return node.identifier!;
    throw new Error(`group ${name} not found`);
};

/** The new text of every edit the rename produces, keyed by the file it lands in. */
const editsByFile = (changes: Record<string, { newText: string }[]> | undefined) => {
    const out: Record<string, string[]> = {};
    for (const [uri, edits] of Object.entries(changes ?? {})) {
        out[decodeURIComponent(uri).split('/').pop()!] = edits.map((edit) => edit.newText);
    }
    return out;
};

describe('renaming through a bare list reference', () => {
    beforeAll(async () => {
        await initWorkspace();
        root = mkdtempSync(join(tmpdir(), 'cosmoteer-bare-ref-'));
        writeFileSync(join(root, 'particles.rules'), 'PARTICLES\n{\n\tFoo\n\t{\n\t\tA = 1\n\t}\n}\n');
        // The `{ Rate = 1 }` element ahead of it is what makes the parser read the next line as an
        // identifier, so the fixture reproduces the shape rather than describing it.
        writeFileSync(
            join(root, 'part.rules'),
            'Part\n{\n\tMediaEffects\n\t[\n\t\t{ Rate = 1 }\n\t\t&<particles.rules>/PARTICLES/Foo\n\t]\n}\n'
        );
        folders = [pathToFileURL(root).href];
        particles = await parseFilePath(join(root, 'particles.rules'));
        part = await parseFilePath(join(root, 'part.rules'));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('rewrites the bare element when the declaration is renamed', async () => {
        const identifier = groupIdentifier(particles, 'Foo');
        const edit = await service.rename(
            particles,
            { line: identifier.position.line, character: identifier.position.characterStart },
            'Bar',
            folders,
            token
        );
        expect(editsByFile(edit?.changes)).toEqual({ 'particles.rules': ['Bar'], 'part.rules': ['Bar'] });
    });

    it('renames from the bare element itself', async () => {
        // The caret sits on the `Foo` segment of the element, the last name in the path.
        const line = 5;
        const text = '\t\t&<particles.rules>/PARTICLES/Foo';
        const edit = await service.rename(
            part,
            { line, character: text.indexOf('/Foo') + 2 },
            'Bar',
            folders,
            token
        );
        expect(editsByFile(edit?.changes)).toEqual({ 'particles.rules': ['Bar'], 'part.rules': ['Bar'] });
    });
});
