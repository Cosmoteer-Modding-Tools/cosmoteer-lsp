import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { DefinitionService } from '../../../src/features/navigation/definition.service';
import { FullNavigationStrategy } from '../../../src/features/navigation/full.navigation-strategy';
import { AbstractNode, AbstractNodeDocument } from '../../../src/core/ast/ast';
import { findNodeByIdentifier, parseFilePath } from '../../../src/utils/ast.utils';
import { isAssignmentNode } from '../../../src/core/ast/ast';
import { findReferenceNode, parseFixture, singleLocation, valueOf } from '../../helpers';
import { initWorkspace, workspaceFile } from '../../workspace-helper';

// End-to-end go-to-definition: cursor position -> reference node -> navigated target
// -> LSP Location (uri + range). Covers in-file, cross-file, file-target and the
// no-definition cases.
const service = DefinitionService.instance;
const navigation = new FullNavigationStrategy();
const token = CancellationToken.None;

/**
 * A cursor position sitting on the start of `node`.
 *
 * @param node the node the cursor should sit on.
 * @returns the line and character of the node's start.
 */
const cursorOn = (node: AbstractNode) => ({
    line: node.position.line,
    character: node.position.characterStart,
});

describe('DefinitionService: go-to-definition', () => {
    let refChain: AbstractNodeDocument;
    let docA: AbstractNodeDocument;

    beforeAll(async () => {
        await initWorkspace();
        refChain = parseFixture('ref-chain.rules', 'file:///ref-chain.rules');
        docA = await parseFilePath(workspaceFile('a.rules'));
    });

    it('in-file: jumps through the alias chain (&Test1/TestValue) to TestValue = 1', async () => {
        const ref = findReferenceNode(refChain, '&Test1/TestValue');
        const target = await navigation.navigate(String(ref.valueType.value), ref, refChain.uri, token);

        const location = singleLocation(await service.getDefinition(refChain, cursorOn(ref), token));

        expect(location.uri).toBe(refChain.uri);
        // Points at the resolved target node (the `1`), proving the cursor→target mapping.
        expect(location.range.start.line).toBe((target as AbstractNode).position.line);
        expect(location.range.start.character).toBe((target as AbstractNode).position.characterStart);
    });

    it('in-file: resolves a reference embedded in a math expression (&B inside `(&A) / (&B) + …`)', async () => {
        // `Result = (&A) / (&B) + ceil(17 / 2)` parses its RHS to a MathExpressionNode whose flattened
        // elements include the `&B` reference. The cursor-to-node finder must descend into the
        // expression (not stop at the whole value) so go-to-definition lands on the `B = 2` sibling.
        const mathDoc = parseFixture('math.rules', 'file:///math.rules');
        const ref = findReferenceNode(mathDoc, '&B'); // appears only inside the Result expression
        const target = await navigation.navigate(String(ref.valueType.value), ref, mathDoc.uri, token);

        const location = singleLocation(await service.getDefinition(mathDoc, cursorOn(ref), token));

        expect(location.uri).toBe(mathDoc.uri);
        expect(location.range.start.line).toBe((target as AbstractNode).position.line);
        expect(location.range.start.character).toBe((target as AbstractNode).position.characterStart);
    });

    it('cross-file: jumps into b.rules for &<./Data/b.rules>/B/InnerValue', async () => {
        const ref = findReferenceNode(docA, '&<./Data/b.rules>/B/InnerValue');
        const target = await navigation.navigate(String(ref.valueType.value), ref, docA.uri, token);

        const location = singleLocation(await service.getDefinition(docA, cursorOn(ref), token));

        expect(location.uri.startsWith('file://')).toBe(true);
        expect(location.uri.endsWith('b.rules')).toBe(true);
        expect(location.range.start.line).toBe((target as AbstractNode).position.line);
    });

    it('file target: a whole-file reference resolves to the file at range 0:0', async () => {
        const doc = parseFixture('def-fileref.rules', 'file:///def-fileref.rules');
        const ref = findReferenceNode(doc, '&<./Data/c.rules>');

        const location = singleLocation(await service.getDefinition(doc, cursorOn(ref), token));

        expect(location.uri.endsWith('c.rules')).toBe(true);
        expect(location.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    });

    it('inherit-and-extend: falls back to the base being extended (`^/0/EditorGroups` -> base)', async () => {
        // The base lacks EditorGroups, so the full ref has no target. Go-to-def should jump
        // to what `^/0` extends (the base group), not do nothing.
        const derived = await parseFilePath(workspaceFile('parts', 'eg_derived.rules'));
        const thing = findNodeByIdentifier(derived, 'Thing')! as AbstractNode & { elements: AbstractNode[] };
        const editorGroups = thing.elements.find(
            (e) => 'identifier' in e && (e as { identifier?: { name?: string } }).identifier?.name === 'EditorGroups'
        ) as unknown as { inheritance: AbstractNode[] };
        const inh = editorGroups.inheritance[0];

        const location = singleLocation(await service.getDefinition(derived, cursorOn(inh), token));
        expect(location.uri.endsWith('eg_base.rules')).toBe(true);
    });

    it('returns null when the cursor is not on a reference (a plain number)', async () => {
        // `Direct = 1` lives inside group A, with the cursor on the number, not a reference.
        const aObj = findNodeByIdentifier(docA, 'A')!;
        const direct = findNodeByIdentifier(aObj, 'Direct')!;
        expect(isAssignmentNode(direct)).toBe(true);
        const numberValue = isAssignmentNode(direct) ? valueOf(direct) : direct;
        const location = await service.getDefinition(docA, cursorOn(numberValue), token);
        expect(location).toBeNull();
    });

    it('returns null for an unresolvable reference', async () => {
        const doc = parseFixture('ref-cycle.rules', 'file:///ref-cycle.rules');
        const ref = findReferenceNode(doc, '&A/x'); // cyclic alias -> no target
        const location = await service.getDefinition(doc, cursorOn(ref), token);
        expect(location).toBeNull();
    });
});
