import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationToken } from 'vscode-languageserver';
import { ReferenceIndex } from '../../../src/features/navigation/reference-index';
import { RenameService } from '../../../src/features/navigation/rename.service';
import { DefinitionService } from '../../../src/features/navigation/definition.service';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isMathExpressionNode } from '../../../src/core/ast/ast';
import { parseFilePath, findNodeByIdentifier } from '../../../src/utils/ast.utils';
import { initWorkspace, WORKSPACE_DATA_DIR, workspaceFile } from '../../workspace-helper';
import { singleLocation } from '../../helpers';

// A `&`-reference embedded in a math expression (`Doubled = (&Base) * 2`) must be a first-class
// reference for navigation, references and rename, not invisible because the RHS is an expression.
const token = CancellationToken.None;
const FOLDERS = [WORKSPACE_DATA_DIR];

/**
 * The first `&Base` reference node sitting inside an expression value.
 *
 * @param doc the parsed document to search.
 * @returns the `&Base` reference node inside `Calc/Doubled`.
 */
const firstEmbeddedBase = (doc: AbstractNodeDocument): AbstractNode => {
    const calc = findNodeByIdentifier(doc, 'Calc') as AbstractNode & { elements: AbstractNode[] };
    const doubled = calc.elements.find((e) => isAssignmentNode(e) && e.left.name === 'Doubled');
    const expr = isAssignmentNode(doubled!) ? doubled!.right : doubled!;
    const ref = isMathExpressionNode(expr)
        ? expr.elements.find((el) => 'valueType' in el && (el as { valueType: { value: unknown } }).valueType.value === '&Base')
        : undefined;
    return ref as AbstractNode;
};

describe('reference embedded in a math expression', () => {
    let doc: AbstractNodeDocument;
    beforeAll(async () => {
        await initWorkspace();
        doc = await parseFilePath(workspaceFile('embedded-ref.rules'));
    });

    it('go-to-definition lands on the sibling declaration (Base = 10)', async () => {
        const ref = firstEmbeddedBase(doc);
        const cursor = { line: ref.position.line, character: ref.position.characterStart + 2 };
        const location = singleLocation(await DefinitionService.instance.getDefinition(doc, cursor, token, FOLDERS));
        expect(location.range.start.line).toBe(4); // `Base = 10` is the 5th line (0-based 4)
    });

    it('find-all-references includes the declaration and every in-expression use', async () => {
        const ref = firstEmbeddedBase(doc);
        const cursor = { line: ref.position.line, character: ref.position.characterStart + 2 };
        const refs = await ReferenceIndex.instance.findReferences(doc, cursor, true, FOLDERS, token);
        // Base = 10 (decl) + `(&Base)` in Doubled + two `&Base` in Mixed = 4 sites.
        expect(refs.length).toBe(4);
    });

    it('rename rewrites the declaration and all embedded uses (no dangling reference)', async () => {
        const ref = firstEmbeddedBase(doc);
        const cursor = { line: ref.position.line, character: ref.position.characterStart + 2 };
        const edit = await RenameService.instance.rename(doc, cursor, 'BaseX', FOLDERS, token);
        const edits = Object.values(edit?.changes ?? {}).flat();
        expect(edits.length).toBe(4);
    });
});
