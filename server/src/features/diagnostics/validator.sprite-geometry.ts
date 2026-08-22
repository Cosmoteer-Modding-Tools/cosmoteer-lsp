import { CancellationToken } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    GroupNode,
    ListNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
} from '../../core/ast/ast';
import { isModRules } from '../../document/document-kind';
import { listElementType } from '../../document/schema/schema-context';
import { effectiveMember } from '../../semantics/effective-member';
import { pngDimensions } from '../../utils/png-dimensions';
import { isAssetValue, resolveAssetPath } from '../navigation/asset-resolver';
import { childNamed, numberOf, readVector, readVectorEvaluated } from '../part-editor/vector-forms';
import { ValidationError } from './validator';
import * as l10n from '@vscode/l10n';

/**
 * Whole-document pass (default on, settable off): a sprite in a list of sprites whose art the game
 * stretches differently from the way it stretches the rest of the list.
 *
 * The game draws an `AtlasSprite` by filling the quad its `Size` names with the whole of its image,
 * whatever the image measures in pixels. Nothing forces a fixed number of pixels per tile, and the
 * game data uses that freedom on purpose: a glow is a 64 by 64 blob drawn eight tiles wide, an
 * asteroid is 256 by 256 pixels of art on a single tile. So neither the size on its own nor the
 * pixels behind it can be judged.
 *
 * What the lists themselves keep constant is the stretch. A part's damage levels, a resource's
 * stack sprites and a wall's blend sprites are the same art in several states, drawn one after the
 * other in the same place, so every entry of one list divides its pixel aspect by its quad aspect
 * to the same number. When one entry does not, that entry alone is squashed or stood on its side
 * the moment the game switches to it, which is a drawing mistake rather than an art decision. The
 * check is that comparison and nothing else, and the first entry the pass can read sets the stretch
 * the others are judged against.
 *
 * The list is found by its element type rather than by its name, so all ten fields that hold
 * sprites this way are covered and a schema regeneration cannot leave one behind.
 *
 * Silence is preferred over a guess everywhere the file does not say enough. An entry that names no
 * image draws nothing at that level and is passed over, which is how the game data writes a damage
 * level that shows an empty tile. An entry whose image is a reference, whose size is math the
 * evaluator cannot finish, or whose image is not on disk is passed over too, as is an entry that
 * takes its size from a base the pass cannot read, since the documented one-by-one default only
 * holds when nothing up the chain names a size. A list deriving from another list is left alone
 * entirely, because the entries the game ends up with are then not the entries in the file. A
 * tolerance of a few percent keeps odd-pixel exports, such as art 255 pixels tall whose siblings
 * are 256, out of the findings.
 */

/** The sprite class whose lists this pass judges. */
const ATLAS_SPRITE_CLASS = 'Cosmoteer.Ships.Rendering.AtlasSprite';

/**
 * How far a sprite's stretch may sit from the list's first one before it is reported. Art is
 * exported at whole pixels, so a quad that was meant to match can still land a pixel or two off.
 * Every real distortion measured in the installed mods is at least an eighth off, so there is room.
 */
const TOLERANCE = 0.03;

/** One entry of a sprite list the pass could read completely. */
interface ReadSprite {
    /** The entry's own group, which the finding falls back to when no size is written here. */
    readonly group: GroupNode;
    /** The size written in this file, which the finding covers and the fix rewrites. */
    readonly sizeNode: AbstractNode | null;
    /** The art's width in pixels, as the file itself measures. */
    readonly pixelWidth: number;
    /** The art's height in pixels, as the file itself measures. */
    readonly pixelHeight: number;
    /** Whether `UVRotation` turns the texture a quarter turn, which swaps the two above. */
    readonly turned: boolean;
    /** The quad's width in tiles. */
    readonly quadWidth: number;
    /** The quad's height in tiles. */
    readonly quadHeight: number;
}

/**
 * The art's pixel size as it reaches the quad, with a quarter turn of the texture applied.
 * @param sprite the read entry.
 * @returns the width and height the quad is filled with.
 */
const drawnPixels = (sprite: ReadSprite): { width: number; height: number } =>
    sprite.turned
        ? { width: sprite.pixelHeight, height: sprite.pixelWidth }
        : { width: sprite.pixelWidth, height: sprite.pixelHeight };

/**
 * Every list in the document whose slot holds sprites, in source order. Both spellings of a member
 * are collected: the game data writes `DamageLevels [ … ]`, and mods often write
 * `DamageLevels = [ … ]`, which parses as an assignment to an unnamed list.
 * @param document the parsed document.
 * @returns the sprite lists to judge.
 */
const spriteLists = (document: AbstractNodeDocument): ListNode[] => {
    const lists: ListNode[] = [];
    const visit = (node: AbstractNode): void => {
        if (isAssignmentNode(node)) {
            if (node.right) visit(node.right);
            return;
        }
        if (isListNode(node)) {
            const element = listElementType(node);
            if (element?.kind === 'group' && element.ref === ATLAS_SPRITE_CLASS) lists.push(node);
        }
        if (isGroupNode(node) || isListNode(node)) for (const child of node.elements) visit(child);
    };
    for (const element of document.elements) visit(element);
    return lists;
};

/**
 * A member of a sprite entry, read the way the game reads it: what the entry writes itself, else
 * what the base it derives from supplies.
 * @param group the sprite entry.
 * @param name the member name.
 * @param cancellationToken cancels the chain walk.
 * @returns the member's value node, or null when neither the entry nor its bases name it.
 */
const spriteMember = async (
    group: GroupNode,
    name: string,
    cancellationToken: CancellationToken
): Promise<AbstractNode | null> => {
    const local = childNamed(group, name);
    if (local || !group.inheritance?.length) return local;
    return (await effectiveMember(group, name, cancellationToken).catch(() => null))?.node ?? null;
};

/**
 * The image a sprite entry draws: its `File`, else the first frame of its `AnimationFiles`, which
 * the game requires every later frame to match in pixel size.
 * @param group the sprite entry.
 * @param cancellationToken cancels the chain walk.
 * @returns the image value node, or null when the entry names no image the pass can follow.
 */
const spriteImage = async (group: GroupNode, cancellationToken: CancellationToken): Promise<AbstractNode | null> => {
    const file = await spriteMember(group, 'File', cancellationToken);
    if (file) return file;
    const frames = await spriteMember(group, 'AnimationFiles', cancellationToken);
    return isListNode(frames) ? (frames.elements[0] ?? null) : null;
};

/**
 * Reads one entry of a sprite list, and answers null for every shape the pass refuses to guess at.
 * @param element the list element.
 * @param uri the document the list is written in, which the image path is resolved against.
 * @param cancellationToken cancels the chain walks and the reference resolution.
 * @returns the entry's pixels and quad, or null when it cannot be read completely.
 */
const readSprite = async (
    element: AbstractNode,
    uri: string,
    cancellationToken: CancellationToken
): Promise<ReadSprite | null> => {
    if (!isGroupNode(element)) return null;
    const image = await spriteImage(element, cancellationToken);
    if (!isAssetValue(image)) return null;
    const path = await resolveAssetPath(image, uri, cancellationToken).catch(() => null);
    if (!path) return null;
    const pixels = await pngDimensions(path);
    if (!pixels) return null;

    const localSize = childNamed(element, 'Size');
    const sizeNode = localSize ?? (await spriteMember(element, 'Size', cancellationToken));
    // The one-by-one default only describes an entry that names no size anywhere. An entry taking
    // its size from a base the pass could not read may well have one, so it stays unjudged.
    if (!sizeNode && element.inheritance?.length) return null;
    const size = sizeNode
        ? (readVector(sizeNode) ?? (await readVectorEvaluated(sizeNode, cancellationToken).catch(() => null)))
        : { x: 1, y: 1 };
    if (!size) return null;
    const quadWidth = Math.abs(size.x);
    const quadHeight = Math.abs(size.y);
    if (!(quadWidth > 0) || !(quadHeight > 0)) return null;

    // A quarter turn of the texture puts its height across the quad's width, so the aspect the
    // stretch is measured from is the turned one.
    const turns = numberOf(await spriteMember(element, 'UVRotation', cancellationToken)) ?? 0;
    return {
        group: element,
        sizeNode: localSize,
        pixelWidth: pixels.width,
        pixelHeight: pixels.height,
        turned: Number.isInteger(turns) && Math.abs(turns) % 2 === 1,
        quadWidth,
        quadHeight,
    };
};

/**
 * How far the art's proportions are pulled by the quad it is drawn in.
 * @param sprite the read entry.
 * @returns the pixel aspect divided by the quad aspect.
 */
const stretchOf = (sprite: ReadSprite): number => {
    const drawn = drawnPixels(sprite);
    return (drawn.width * sprite.quadHeight) / (drawn.height * sprite.quadWidth);
};

/**
 * A size component as it is written back into the file, kept short enough to read.
 * @param value the computed number of tiles.
 * @returns the number as text.
 */
const formatTiles = (value: number): string => String(Math.round(value * 10_000) / 10_000);

/**
 * The size that would draw this entry's art the way the list's first entry is drawn, by keeping the
 * first entry's pixels per tile on each axis.
 * @param sprite the entry to correct.
 * @param first the entry that sets the stretch.
 * @returns the size as it would be written.
 */
const correctedSize = (sprite: ReadSprite, first: ReadSprite): string => {
    const drawn = drawnPixels(sprite);
    const reference = drawnPixels(first);
    const width = (drawn.width * first.quadWidth) / reference.width;
    const height = (drawn.height * first.quadHeight) / reference.height;
    return `[${formatTiles(width)}, ${formatTiles(height)}]`;
};

/**
 * Compares one sprite list and collects a finding for every entry drawn out of step with the first
 * entry the pass could read.
 * @param list the sprite list.
 * @param uri the document the list is written in.
 * @param cancellationToken cancels the reads.
 * @param errors collects the findings.
 */
const judgeList = async (
    list: ListNode,
    uri: string,
    cancellationToken: CancellationToken,
    errors: ValidationError[]
): Promise<void> => {
    // A list deriving from another list is drawn with the base's entries in front of these, so the
    // entries in the file are not the list the game holds.
    if (list.inheritance?.length) return;
    let first: ReadSprite | null = null;
    for (const element of list.elements) {
        if (cancellationToken.isCancellationRequested) return;
        const sprite = await readSprite(element, uri, cancellationToken);
        if (!sprite) continue;
        if (!first) {
            first = sprite;
            continue;
        }
        const reference = stretchOf(first);
        if (Math.abs(stretchOf(sprite) - reference) <= reference * TOLERANCE) continue;
        const corrected = correctedSize(sprite, first);
        errors.push({
            message: l10n.t(
                'The game stretches a sprite to fill the size it names, so a size the rest of this list does not share draws this one distorted. Its art is {0} by {1} pixels, which the first sprite of the list draws at a size of {2}.',
                sprite.pixelWidth,
                sprite.pixelHeight,
                corrected
            ),
            node: sprite.sizeNode ?? sprite.group,
            severity: 'hint',
            ...(sprite.sizeNode
                ? { data: { quickFix: { title: l10n.t("Change to '{0}'", corrected), newText: corrected } } }
                : {}),
        });
    }
};

/**
 * Runs the sprite-geometry check over a document.
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk, the inheritance reads and the image lookups.
 * @returns the findings, in source order per list.
 */
export const validateSpriteGeometry = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (isModRules(document.uri)) return [];
    const errors: ValidationError[] = [];
    for (const list of spriteLists(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        await judgeList(list, document.uri, cancellationToken, errors);
    }
    return errors;
};
