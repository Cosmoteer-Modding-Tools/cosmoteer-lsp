import { CancellationToken, Location, Position, Range } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isDocumentNode, ValueNode } from '../../core/ast/ast';
import { getStartOfAstNode } from '../../utils/ast.utils';
import { FileWithPath, isFile } from '../../workspace/cosmoteer-workspace.service';
import { DefinitionService } from './definition.service';
import { FullNavigationStrategy } from './full.navigation-strategy';
import { filePathToUri, segmentName, segmentSpans, SegmentSpan } from './navigation-strategy';
import { definitionLocationOf, locationKey } from './reference-location';

/**
 * Reading one segment of a reference path.
 *
 * A Cosmoteer symbol is named by whichever segment of a path resolves to it, and that is rarely the
 * last one: `&/SW_COLORS/Lime/RGBA` names `SW_COLORS`, `Lime` and `RGBA`, each of them a symbol in
 * its own right. Every feature that answers "what is under the cursor" or "which sites name this
 * symbol" therefore works per segment, and they all have to agree on where a segment sits in the
 * text and what it resolves to, or the highlight, the rename and the reference list disagree about
 * the same path.
 */
const navigation = new FullNavigationStrategy();

/** A segment that names something: a path sigil, a positional index and the `<file.rules>` part of
 *  a path are steps on the way rather than symbols. */
export const MEMBER_SEGMENT_NAME = /^[A-Za-z_]\w*$/;

/**
 * How far an offset into the stored reference text has to move to land on the same character of the
 * line, or undefined when the two cannot be lined up at all.
 *
 * The stored text is not always the text on the line. An inheritance reference is written without a
 * sigil (`Child : Base`) and stored as `&Base`, so its offsets sit one character ahead. A reference
 * inside a math expression (`RecCrew = (&CrewRequired) + 1`) carries the closing paren in its span,
 * so its span is one character longer than what it stores while the offsets still line up.
 *
 * @param node the reference value node.
 * @param value the node's stored reference text.
 * @returns the offset shift, or undefined when the text and the span cannot be aligned.
 */
export const valueShift = (node: ValueNode, value: string): number | undefined => {
    const span = node.position.characterEnd - node.position.characterStart;
    if (value.length === span || value.length === span - 1) return 0;
    if (value.length === span + 1 && value.startsWith('&')) return 1;
    return undefined;
};

/**
 * The document range covering a segment's name, so a long path is rewritten or lit up only where it
 * matches.
 *
 * @param node the reference value node.
 * @param span the segment inside its text.
 * @returns the range of the segment's name, or the whole value when the two cannot be aligned.
 */
export const segmentNameRange = (node: ValueNode, span: SegmentSpan): Range => {
    const { line, characterStart, characterEnd } = node.position;
    const value = String(node.valueType.value);
    const wholeValue = Range.create(line, characterStart, line, characterEnd);
    const shift = valueShift(node, value);
    if (shift === undefined) return wholeValue;
    const sigil = span.text.startsWith('&') ? 1 : 0;
    const start = characterStart + span.start + sigil - shift;
    const end = characterStart + span.end - shift;
    // An offset that still lands outside the value falls back to the whole value, which is real text
    // whatever the reference is written like.
    return start < characterStart || end > characterEnd || end <= start
        ? wholeValue
        : Range.create(line, start, line, end);
};

/**
 * The segment the cursor sits on, falling back to the last one when the cursor is past the text.
 *
 * @param node the reference value node under the cursor.
 * @param position the cursor position.
 * @returns the segment, or undefined for a reference with none.
 */
export const segmentSpanAt = (node: ValueNode, position: Position): SegmentSpan | undefined => {
    const value = String(node.valueType.value);
    const relative = position.character - node.position.characterStart + (valueShift(node, value) ?? 0);
    const spans = segmentSpans(value);
    return spans.find((candidate) => relative >= candidate.start && relative <= candidate.end) ?? spans.at(-1);
};

/**
 * The segment a symbol search starts from: the one under the cursor when it names something, and
 * the path's endpoint otherwise. A caret on the `&` sigil or inside the `<file.rules>` part is not
 * pointing at a symbol of its own, and the reader asking there means the reference as a whole.
 *
 * @param node the reference value node under the cursor.
 * @param position the cursor position.
 * @returns the segment to resolve, or undefined for a reference with none.
 */
export const namedSegmentAt = (node: ValueNode, position: Position): SegmentSpan | undefined => {
    const span = segmentSpanAt(node, position);
    if (!span || MEMBER_SEGMENT_NAME.test(segmentName(span))) return span;
    return segmentSpans(String(node.valueType.value)).at(-1);
};

/**
 * What a segment of a reference path resolves to. The last segment is resolved the way
 * go-to-definition resolves the whole reference, so a mod-action target and the prefix fallback
 * answer the same as they do everywhere else, while an inner segment is resolved by navigating the
 * path up to it, which is what lets a mid-path name be found at all.
 *
 * @param document the document the reference lives in.
 * @param reference the reference value node.
 * @param span the segment being resolved.
 * @param cancellationToken cancels the cross-file resolution.
 * @returns the target node, or null when the segment resolves nowhere or to a whole file.
 */
export const segmentTarget = async (
    document: AbstractNodeDocument,
    reference: ValueNode,
    span: SegmentSpan,
    cancellationToken: CancellationToken
): Promise<AbstractNode | FileWithPath | null> => {
    const value = String(reference.valueType.value);
    const resolved = await (span.end === value.length
        ? DefinitionService.instance.resolveReferenceTarget(document, reference, cancellationToken).catch(() => null)
        : navigation
              .navigate(value.substring(0, span.end), reference, getStartOfAstNode(reference).uri, cancellationToken)
              .catch(() => null));
    return resolved ?? null;
};

/**
 * {@link segmentTarget} narrowed to an AST node, so a segment naming a whole file answers nothing.
 *
 * @param document the document the reference lives in.
 * @param reference the reference value node.
 * @param span the segment being resolved.
 * @param cancellationToken cancels the cross-file resolution.
 * @returns the target node, or null when the segment resolves nowhere or to a whole file.
 */
export const segmentTargetNode = async (
    document: AbstractNodeDocument,
    reference: ValueNode,
    span: SegmentSpan,
    cancellationToken: CancellationToken
): Promise<AbstractNode | null> => {
    const resolved = await segmentTarget(document, reference, span, cancellationToken);
    return !resolved || isFile(resolved as FileWithPath) ? null : (resolved as AbstractNode);
};

/**
 * The identity a reference segment resolves to, as a {@link locationKey}.
 *
 * @param document the document the reference lives in.
 * @param reference the reference value node.
 * @param span the segment being resolved.
 * @param cancellationToken cancels the cross-file resolution.
 * @returns the key of the segment's target, or null when it resolves nowhere or to a whole file.
 */
export const segmentTargetKey = async (
    document: AbstractNodeDocument,
    reference: ValueNode,
    span: SegmentSpan,
    cancellationToken: CancellationToken
): Promise<string | null> => {
    const target = await segmentTarget(document, reference, span, cancellationToken);
    return target ? segmentTargetIdentity(target) : null;
};

/**
 * The identity of whatever a segment resolved to, as a {@link locationKey}. A whole file is keyed
 * by its uri alone, so the two shapes a file comes back as, the workspace entry and the parsed
 * document, answer the same key.
 *
 * @param target the resolved target.
 * @returns the identity key.
 */
export const segmentTargetIdentity = (target: AbstractNode | FileWithPath): string => {
    if (isFile(target as FileWithPath)) return locationKey(fileLocation((target as FileWithPath).path));
    const node = target as AbstractNode;
    if (isDocumentNode(node)) return locationKey(fileLocation((node as AbstractNodeDocument).uri));
    return locationKey(definitionLocationOf(node));
};

/** The location a whole file is identified by: its uri, with no range of its own. */
const fileLocation = (pathOrUri: string): Location => ({
    uri: filePathToUri(pathOrUri),
    range: Range.create(0, 0, 0, 0),
});

/**
 * A test for the name appearing where a reference could use it: after a path separator
 * (`&…/Name`), right behind the `&` sigil, or behind the `:` of an inheritance header, which is
 * written without a sigil. A file that only declares the name, never pointing at one, cannot hold
 * a site, so this is what a project-wide search gates its candidates on before parsing them.
 *
 * @param name the symbol name being searched for.
 * @returns the text test to gate candidate files with.
 */
export const referenceShapeOf = (name: string): RegExp =>
    new RegExp(`(?:[/&]|:\\s*)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);

/**
 * The segments of a reference that spell `name`, or an empty array when none does. The cheap
 * pre-filter every site search runs before resolving anything.
 *
 * @param reference the reference value node.
 * @param name the symbol name being searched for.
 * @returns the matching segments, in path order.
 */
export const segmentsNamed = (reference: ValueNode, name: string): SegmentSpan[] => {
    const value = String(reference.valueType.value);
    if (!value.includes(name)) return [];
    return segmentSpans(value).filter((span) => segmentName(span) === name);
};
