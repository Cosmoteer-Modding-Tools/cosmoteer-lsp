import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { RenameService } from '../../../src/features/navigation/rename.service';
import { AbstractNodeDocument, isAssignmentNode, isGroupNode, isValueNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { walkAst } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

// End-to-end rename over the fixture workspace: the declaration plus every reference
// SEGMENT (endpoint and mid-path) that resolves to the target is rewritten.
const service = RenameService.instance;
const token = CancellationToken.None;
const FOLDERS = [WORKSPACE_DATA_DIR];

const positionOf = (p: { line: number; characterStart: number }) => ({ line: p.line, character: p.characterStart });

const assignmentKey = (doc: AbstractNodeDocument, name: string) => {
    for (const node of walkAst(doc)) if (isAssignmentNode(node) && node.left.name === name) return node.left;
    throw new Error(`assignment ${name} not found`);
};

const groupIdentifier = (doc: AbstractNodeDocument, name: string) => {
    for (const node of walkAst(doc)) if (isGroupNode(node) && node.identifier?.name === name) return node.identifier!;
    throw new Error(`group ${name} not found`);
};

/** The text a TextEdit produces and the line it targets, for compact assertions. */
const editText = (edit: TextEdit) => edit.newText;

describe('RenameService', () => {
    let bDoc: AbstractNodeDocument;
    let aDoc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        bDoc = await parseFilePath(workspaceFile('b.rules'));
        aDoc = await parseFilePath(workspaceFile('a.rules'));
    });

    it('prepareRename returns the identifier range and current name on a definition', async () => {
        const inner = assignmentKey(bDoc, 'InnerValue');
        const prep = await service.prepareRename(bDoc, positionOf(inner.position));
        expect(prep?.placeholder).toBe('InnerValue');
        expect(prep?.range.start.character).toBe(inner.position.characterStart);
    });

    it('renames a definition and its cross-file reference segment', async () => {
        const inner = assignmentKey(bDoc, 'InnerValue');
        const edit = await service.rename(bDoc, positionOf(inner.position), 'RenamedInner', FOLDERS, token);
        expect(edit).not.toBeNull();

        const files = Object.keys(edit!.changes!);
        const bFile = files.find((f) => f.endsWith('b.rules'))!;
        const aFile = files.find((f) => f.endsWith('a.rules'))!;

        // Declaration rewritten in b.rules.
        expect(edit!.changes![bFile].map(editText)).toContain('RenamedInner');
        // The `…/B/InnerValue` reference segment rewritten in a.rules.
        expect(edit!.changes![aFile].map(editText)).toContain('RenamedInner');
    });

    it('rewrites BOTH the endpoint and the mid-path occurrences when renaming group B', async () => {
        // a.rules references B as `…/B` (endpoint) AND `…/B/InnerValue`, `…/B/ToC`, … (mid-path).
        const edit = await service.rename(bDoc, positionOf(groupIdentifier(bDoc, 'B').position), 'Bee', FOLDERS, token);
        expect(edit).not.toBeNull();

        const aFile = Object.keys(edit!.changes!).find((f) => f.endsWith('a.rules'))!;
        const aEdits = edit!.changes![aFile];
        // One edit per reference to B in a.rules (ToB, ToC, ToNested, RefToB = 4).
        expect(aEdits.length).toBeGreaterThanOrEqual(4);
        expect(aEdits.every((e) => e.newText === 'Bee')).toBe(true);
        // Each edit replaces exactly the 1-char `B` segment, never the surrounding path.
        expect(aEdits.every((e) => e.range.end.character - e.range.start.character === 1)).toBe(true);
    });

    it('rename from a REFERENCE site resolves to the same target', async () => {
        const toB = [...walkAst(aDoc)].find(
            (n) => isValueNode(n) && n.valueType.value === '&<./Data/b.rules>/B/InnerValue'
        )!;
        // Cursor on the trailing `InnerValue` segment of the reference.
        const innerStart = toB.position.characterStart + '&<./Data/b.rules>/B/'.length;
        const edit = await service.rename(aDoc, { line: toB.position.line, character: innerStart }, 'FromRef', FOLDERS, token);

        expect(edit).not.toBeNull();
        const bFile = Object.keys(edit!.changes!).find((f) => f.endsWith('b.rules'))!;
        expect(edit!.changes![bFile].map(editText)).toContain('FromRef'); // declaration in b.rules
    });

    it('rejects an invalid new name', async () => {
        const inner = assignmentKey(bDoc, 'InnerValue');
        const edit = await service.rename(bDoc, positionOf(inner.position), 'bad name/slash', FOLDERS, token);
        expect(edit).toBeNull();
    });
});
