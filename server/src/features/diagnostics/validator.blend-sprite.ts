import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
    ValueNode,
} from '../../core/ast/ast';
import { childNodesOf } from '../../utils/ast.utils';
import { listElementType } from '../../document/schema/schema-context';
import { ValidationError } from './validator';

/** The member naming which of the surrounding cells a blend sprite is drawn for. */
const SITUATION_CODE = 'situationcode';

/** The three characters the code expander understands. Anything else reaches its default case. */
const SITUATION_CHARACTERS = /^[01*]*$/;

/** The element class whose codes describe the eight cells around a part, so a code is eight long. */
const AMBIGUOUS_BLEND_SPRITE = 'Cosmoteer.Ships.Rendering.AmbiguousBlendSprite';

/** How many characters a code in an {@link AMBIGUOUS_BLEND_SPRITE} carries, one per neighbour. */
const NEIGHBOUR_COUNT = 8;

/**
 * The situation code a node writes, as it was written.
 *
 * @param node the node to read.
 * @returns the value node and its string, or undefined when the node writes no plain code.
 */
const codeOf = (node: AbstractNode | undefined): { node: ValueNode; code: string } | undefined => {
    if (!node || !isValueNode(node)) return undefined;
    if (node.valueType.type === 'Reference') return undefined;
    return { node, code: String(node.valueType.value) };
};

/**
 * Every situation code written anywhere under a node, in the assignment spelling the field takes.
 *
 * @param node the node to walk.
 * @returns a generator of the codes found under it.
 */
function* situationCodesIn(node: AbstractNode): Generator<{ node: ValueNode; code: string }> {
    if (isAssignmentNode(node) && node.left.name.toLowerCase() === SITUATION_CODE) {
        const written = codeOf(node.right ?? undefined);
        if (written) yield written;
    }
    for (const child of childNodesOf(node)) yield* situationCodesIn(child);
}

/**
 * Every situation code written by a direct element of a list the schema types as eight-neighbour
 * blend sprites, which is the one slot whose code length the engine fixes.
 *
 * @param node the node to walk.
 * @returns a generator of the codes found in such a list.
 */
function* eightNeighbourCodesIn(node: AbstractNode): Generator<{ node: ValueNode; code: string }> {
    if (isListNode(node)) {
        const element = listElementType(node);
        if (element?.kind === 'group' && element.ref === AMBIGUOUS_BLEND_SPRITE) {
            for (const entry of node.elements) {
                if (!isGroupNode(entry)) continue;
                for (const member of entry.elements) {
                    if (!isAssignmentNode(member) || member.left.name.toLowerCase() !== SITUATION_CODE) continue;
                    const written = codeOf(member.right ?? undefined);
                    if (written) yield written;
                }
            }
        }
    }
    for (const child of childNodesOf(node)) yield* eightNeighbourCodesIn(child);
}

/**
 * Flags a blend sprite situation code the engine cannot expand.
 *
 * A code says, one character per surrounding cell, whether that neighbour blends: `0` for no, `1`
 * for yes, `*` for either. The expander has a case for each of the three and throws on anything
 * else the first time that sprite is drawn, which is well after the file loaded. Its length is
 * checked too, where the slot fixes one: a code in an eight-neighbour list that is not eight
 * characters long stops the sprites being generated at all.
 *
 * The character rule is judged wherever a code is written, including the untyped template groups
 * the game's own files keep their shared codes in, since it needs nothing but the text. The length
 * rule is judged only where the list's element class resolves, so a code written into a template
 * group or into a slot of another shape is left alone.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per code carrying a character the expander refuses, and one per code whose
 *          length its slot does not allow.
 */
export const validateBlendSpriteCodes = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    const errors: ValidationError[] = [];
    const flaggedCharacters = new Set<ValueNode>();
    for (const element of document.elements) {
        if (cancellationToken.isCancellationRequested) return [];
        for (const written of situationCodesIn(element)) {
            if (SITUATION_CHARACTERS.test(written.code)) continue;
            const offending = [...written.code].find((character) => !SITUATION_CHARACTERS.test(character)) ?? '';
            flaggedCharacters.add(written.node);
            errors.push({
                message: l10n.t(
                    "A situation code is written with '0', '1' and '*' only. The game throws on '{0}' the first time this sprite is drawn.",
                    offending
                ),
                node: written.node,
                severity: 'error',
            });
        }
    }
    for (const element of document.elements) {
        if (cancellationToken.isCancellationRequested) return [];
        for (const written of eightNeighbourCodesIn(element)) {
            if (flaggedCharacters.has(written.node) || written.code.length === NEIGHBOUR_COUNT) continue;
            errors.push({
                message: l10n.t(
                    'This code has {0} characters. A blend sprite here needs one per surrounding cell, so the game refuses to generate its sprites unless the code is {1} long.',
                    String(written.code.length),
                    String(NEIGHBOUR_COUNT)
                ),
                node: written.node,
                severity: 'error',
            });
        }
    }
    return errors;
};
