import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ReferenceIndex, referenceNodesOf } from '../../../src/features/navigation/reference-index';
import { AbstractNodeDocument, isAssignmentNode, isGroupNode, isValueNode, GroupNode } from '../../../src/core/ast/ast';
import { parseFilePath } from '../../../src/utils/ast.utils';
import { walkAst } from '../../helpers';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';

// End-to-end find-all-references over the on-disk fixture workspace: the reverse index
// resolves every reference, then a query at a definition (or at a reference) returns the
// sites bucketed under it. `a.rules` references members of `b.rules`, so b's defs have
// referrers in a.
const index = ReferenceIndex.instance;
const token = CancellationToken.None;
const FOLDERS = [WORKSPACE_DATA_DIR];

const positionOf = (p: { line: number; characterStart: number }) => ({ line: p.line, character: p.characterStart });

/** The `InnerValue = 100` assignment's key identifier in b.rules. */
const innerValueKey = (b: AbstractNodeDocument) => {
    for (const node of walkAst(b)) if (isAssignmentNode(node) && node.left.name === 'InnerValue') return node.left;
    throw new Error('InnerValue not found');
};

/** The `B { … }` group identifier in b.rules. */
const groupBIdentifier = (b: AbstractNodeDocument) => {
    for (const node of walkAst(b)) if (isGroupNode(node) && node.identifier?.name === 'B') return node.identifier!;
    throw new Error('group B not found');
};

describe('ReferenceIndex: find-all-references', () => {
    let bDoc: AbstractNodeDocument;
    let aDoc: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        bDoc = await parseFilePath(workspaceFile('b.rules'));
        aDoc = await parseFilePath(workspaceFile('a.rules'));
    });

    it('from the definition: InnerValue is referenced by a.rules', async () => {
        const refs = await index.findReferences(bDoc, positionOf(innerValueKey(bDoc).position), false, FOLDERS, token);

        expect(refs.length).toBe(1);
        expect(refs[0].uri.endsWith('a.rules')).toBe(true);
    });

    it('includeDeclaration adds the definition location', async () => {
        const withDecl = await index.findReferences(bDoc, positionOf(innerValueKey(bDoc).position), true, FOLDERS, token);

        expect(withDecl.length).toBe(2);
        expect(withDecl.some((r) => r.uri.endsWith('b.rules'))).toBe(true);
        expect(withDecl.some((r) => r.uri.endsWith('a.rules'))).toBe(true);
    });

    it('clicking a group identifier finds references to that group (RefToB → B)', async () => {
        const refs = await index.findReferences(bDoc, positionOf(groupBIdentifier(bDoc).position), false, FOLDERS, token);

        // a.rules `RefToB = &<./Data/b.rules>/B` points at the whole B group.
        expect(refs.some((r) => r.uri.endsWith('a.rules'))).toBe(true);
    });

    it('from a reference: querying on a.rules `ToB` returns the same target, incl. its declaration', async () => {
        const toB = [...walkAst(aDoc)].find(
            (n) => isValueNode(n) && n.valueType.value === '&<./Data/b.rules>/B/InnerValue'
        )!;
        const refs = await index.findReferences(aDoc, positionOf(toB.position), true, FOLDERS, token);

        expect(refs.some((r) => r.uri.endsWith('a.rules'))).toBe(true); // the reference site
        expect(refs.some((r) => r.uri.endsWith('b.rules'))).toBe(true); // the declaration
    });

    it('finds a cross-file INHERITANCE reference to a group (the real Part scenario)', async () => {
        // base.rules `Base` is inherited cross-file by a.rules `AChild : &<./Data/base.rules>/Base`,
        // exactly how every part does `Part : <../base_part.rules>/Part`.
        const baseDoc = await parseFilePath(workspaceFile('base.rules'));
        const baseObj = [...walkAst(baseDoc)].find(
            (n) => isGroupNode(n) && (n as GroupNode).identifier?.name === 'Base'
        ) as GroupNode;
        const refs = await index.findReferences(
            baseDoc,
            positionOf(baseObj.identifier!.position),
            false,
            FOLDERS,
            token
        );
        expect(refs.some((r) => r.uri.endsWith('a.rules'))).toBe(true);
    });

    it('does not crash on null AST slots (error-parsed game files)', () => {
        // `Bad =` (no value) and missing list elements leave null slots; the search must
        // skip them, not throw `Cannot read properties of null (reading 'type')`.
        const doc = {
            type: 'Document',
            uri: 'file:///x.rules',
            elements: [
                null,
                {
                    type: 'Assignment',
                    assignmentType: 'Equals',
                    left: { type: 'Identifier', name: 'Bad', position: {} },
                    right: null,
                },
            ],
        } as unknown as AbstractNodeDocument;
        expect(() => Array.from(referenceNodesOf(doc))).not.toThrow();
    });

    it('returns [] when the cursor is on nothing referenceable', async () => {
        const refs = await index.findReferences(bDoc, { line: 99, character: 0 }, true, FOLDERS, token);
        expect(refs).toEqual([]);
    });

});
