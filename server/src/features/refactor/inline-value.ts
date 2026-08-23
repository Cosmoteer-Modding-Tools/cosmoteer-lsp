import { readFile } from 'fs/promises';
import { dirname } from 'path';
import * as l10n from '@vscode/l10n';
import { CancellationToken, CodeAction, CodeActionKind, Position, Range, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AbstractNode, AbstractNodeDocument, ValueNode, isGroupNode, isListNode, isValueNode } from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { isReferenceValue } from '../navigation/definition.service';
import { FullNavigationStrategy } from '../navigation/full.navigation-strategy';
import { uriToFsPath } from '../navigation/workspace-files';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { findNodeAtPosition } from '../../utils/ast.utils';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { analyzeReferences, applyRebases } from './shared-base/reference-safety';
import { CosmoteerWorkspaceService } from '../../workspace/cosmoteer-workspace.service';
import { isUnderFolder } from '../../mod/strings-folder';
import { hasMultiLineString } from './shared-base/member-record';

/**
 * The "inline this reference" refactoring, the inverse of the extract-value one.
 *
 * A constant is worth naming until it is read once. Then the name costs a reader a jump to another
 * part of the file, or to another file, to learn a single number, and the way back is to copy the
 * literal by hand and delete the declaration. This replaces the reference with the value the game
 * reads through it, spelled the way its own file spells it, so `50%`, `45d` and a quoted string all
 * survive the move.
 *
 * The value it writes is the one the game ends at, not the next hop: a reference naming a reference
 * is followed to the literal, which is what the game computes and what "inline" means everywhere
 * else. The declaration is left alone. Removing it is only safe once nothing else reads it, which
 * the unused-constant hint already decides on its own terms and offers there.
 *
 * What it refuses, and why each refusal is load bearing:
 *
 * - A container target. A group or a list has no single literal, and its position spans from its
 *   opening brace to its closing one, so slicing it is not a value but a block.
 * - A base in an inheritance list. The parser writes a `&`-prefixed value for a bare `Child : Base`
 *   whose source text carries no `&`, so the text and the value disagree, and inheritance is a
 *   relationship rather than a value to begin with.
 * - A manifest. A path in `mod.rules` resolves against the game install rather than against the file
 *   it is written in, so what the editor resolves is not what an inline would mean.
 * - A literal whose own meaning depends on where it is written. `analyzeReferences` refuses `~`, `^`,
 *   `:` and bare `&Name` outright, since each of those is read against its surroundings, and it
 *   rewrites a relative asset path so a `File = icon.png` still names the same file from its new
 *   directory.
 */

/** How many characters of the inlined value the title shows before it is cut. */
const TITLE_WIDTH = 30;

/**
 * The value types an inline can write. A reference is excluded because a resolved target that is
 * still a reference means the walk stopped at a form this editor does not follow, and writing it
 * where it stands would move a path that is read against its own surroundings.
 */
const INLINEABLE_TYPES: ReadonlySet<string> = new Set(['Number', 'Boolean', 'String', 'Sprite', 'Sound', 'Shader']);

/**
 * Whether a resolved target is a single written value this refactoring can copy.
 *
 * @param node the resolved target.
 * @returns true when the target is a scalar the source text spells on one line.
 */
const isInlineableTarget = (node: AbstractNode | null | undefined): node is ValueNode =>
    !!node &&
    isValueNode(node) &&
    !node.parenthesized &&
    INLINEABLE_TYPES.has(node.valueType.type) &&
    node.position !== undefined;

/**
 * Whether a node is one of the bases its container inherits from rather than a value it holds.
 *
 * @param node the node to judge.
 * @returns true when the node sits in an inheritance list.
 */
const isInheritanceMember = (node: AbstractNode): boolean => {
    const parent = node.parent;
    if (!parent || !(isGroupNode(parent) || isListNode(parent))) return false;
    return parent.inheritance?.includes(node as ValueNode) === true;
};

/**
 * The source text of the file a target was parsed from.
 *
 * @param targetUri the uri or path that file was parsed under.
 * @param documentUri the uri of the document the caret is in.
 * @param documentText the caret document's text, already in hand.
 * @returns the text, or null when the file could not be read.
 */
const sourceTextOf = async (
    targetUri: string,
    documentUri: string,
    documentText: string
): Promise<string | null> => {
    if (targetUri === documentUri) return documentText;
    return readFile(uriToFsPath(targetUri), { encoding: 'utf-8' }).catch(() => null);
};

/**
 * The "inline this reference" refactoring for the reference under the cursor.
 *
 * @param document the parsed document the cursor is in.
 * @param text the document's full source text, to place the edit and to read a same-file target.
 * @param cursor the cursor position of the code-action request.
 * @param uri the document uri the edit applies to.
 * @param cancellationToken cancels the cross-file resolution of the reference.
 * @returns the code action, or undefined when the reference is one this cannot mean anything for.
 */
export const inlineValueCodeAction = async (
    document: AbstractNodeDocument,
    text: string,
    cursor: Position,
    uri: string,
    cancellationToken: CancellationToken
): Promise<CodeAction | undefined> => {
    if (isModRules(uri)) return undefined;
    const node = findNodeAtPosition(document, cursor);
    if (!isReferenceValue(node) || isInheritanceMember(node)) return undefined;

    const target = await new FullNavigationStrategy()
        .navigate(String(node.valueType.value), node, getStartOfAstNode(node).uri, cancellationToken)
        .catch(() => null);
    if (!target || isFile(target as FileWithPath) || !isInlineableTarget(target as AbstractNode)) return undefined;

    const targetNode = target as ValueNode;
    const targetUri = getStartOfAstNode(targetNode).uri;
    const targetText = await sourceTextOf(targetUri, uri, text);
    if (targetText === null) return undefined;

    const literal = targetText.slice(targetNode.position.start, targetNode.position.end);
    if (literal.length === 0 || literal.includes('\n') || hasMultiLineString(literal)) return undefined;

    // The literal moves from its own file's directory to this one, which changes what a relative
    // asset path names. The verdict rewrites the ones it can and refuses the forms it cannot. A value
    // coming out of the game's own tree into a mod is rewritten to the `./Data/…` form the game reads
    // from its working directory, since a path counted out of the mod's folder would name the file
    // only on the machine the inline was performed on.
    const dataRoot = CosmoteerWorkspaceService.instance.dataRootPath;
    const targetPath = uriToFsPath(targetUri);
    const sourcePath = uriToFsPath(uri);
    const crossesOutOfGameTree =
        !!dataRoot && isUnderFolder(targetPath, dataRoot) && !isUnderFolder(sourcePath, dataRoot);
    const verdict = analyzeReferences(
        literal,
        dirname(targetPath),
        dirname(sourcePath),
        crossesOutOfGameTree ? { gameRootDir: dataRoot } : undefined
    );
    if (!verdict.safe) return undefined;
    const inlined = applyRebases(literal, verdict.rebases);

    const buffer = TextDocument.create(uri, 'rules', 0, text);
    // A reference the parser read as parenthesized may or may not carry the closing paren inside its
    // own span: the math-group path extends the span over it, the function-argument path does not.
    // The written text is what settles it, so the span is judged rather than the flag.
    const spanned = text.slice(node.position.start, node.position.end);
    const end = spanned.endsWith(')') ? node.position.end - 1 : node.position.end;
    const range = Range.create(buffer.positionAt(node.position.start), buffer.positionAt(end));
    const shown = inlined.length > TITLE_WIDTH ? `${inlined.slice(0, TITLE_WIDTH)}…` : inlined;
    return {
        title: l10n.t('Inline the value {0}', shown),
        kind: CodeActionKind.RefactorInline,
        edit: { changes: { [uri]: [TextEdit.replace(range, inlined)] } },
    };
};
