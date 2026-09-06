import { Color, ColorInformation, ColorPresentation, Range, TextEdit } from 'vscode-languageserver';
import { AbstractNodeDocument, isValueNode, ValueNode } from '../../core/ast/ast';
import { keyDeclarationsOf } from '../completion/localization-key.index';
import { normalizeUri } from '../navigation/reference-location';
import { colorOfTag, markupPositionOf, markupTextOf, NAMED_COLORS, scanMarkup } from '../text-markup/text-markup';
import { MarkupSpan, MarkupTag } from '../text-markup/text-markup.types';

/**
 * Colour swatches for the markup of a language file. The text the game draws carries its own colour
 * tags (`<color r='250' g='176' b='86'>`, `<background hex='202020'>`), which are colours the editor
 * can show and the picker can rewrite exactly like the `{ Rf Gf Bf }` groups of a `.rules` file.
 *
 * Only the folder the game reads language files from is looked at. Elsewhere a `<color …>` in a
 * string is not markup, it is text.
 */
const STRINGS_PATH_SEGMENT = /(^|\/)strings\//;

/** A colour tag of a language file, with the value it was written in. */
interface MarkupColorTag {
    readonly tag: MarkupTag;
    readonly node: ValueNode;
    readonly span: MarkupSpan;
}

/**
 * Every colour tag written in a language file's strings.
 *
 * @param document the parsed language file.
 * @returns each `<color>` or `<background>` tag, with the value node and written text it sits in.
 */
function* markupColorTags(document: AbstractNodeDocument): Generator<MarkupColorTag> {
    if (!STRINGS_PATH_SEGMENT.test(normalizeUri(document.uri))) return;
    for (const declaration of keyDeclarationsOf(document)) {
        const node = declaration.node;
        if (!isValueNode(node) || node.valueType.type !== 'String') continue;
        const span = markupTextOf(node);
        if (!span) continue;
        const scan = scanMarkup(span.text);
        if (!scan.hasMarkup) continue;
        for (const tag of scan.tags) {
            const name = tag.name.toLowerCase();
            if (!tag.closing && (name === 'color' || name === 'background')) yield { tag, node, span };
        }
    }
}

/**
 * The range a colour tag occupies, from its `<` through its `>`. This is both the swatch range and
 * the picker's edit range, and the two have to be identical: the picker tracks the region an applied
 * edit covered and hands it back as the range of the next change.
 *
 * @param found the colour tag.
 * @returns the range of the whole tag.
 */
const tagRange = ({ tag, node, span }: MarkupColorTag): Range =>
    Range.create(
        markupPositionOf(node, span, span.offset + tag.start),
        markupPositionOf(node, span, span.offset + tag.end)
    );

/**
 * Every colour a language file's markup sets, read the way `TextBuilder.ParseColor` reads it: the
 * `hex` attribute, else `name`, else the `r`, `g`, `b` and `a` channels divided by 255. A tag whose
 * colour cannot be read gets no swatch, since a swatch the picker cannot write back to is worse
 * than none.
 *
 * @param document the parsed language file.
 * @returns one swatch per readable colour tag.
 */
export const markupColors = (document: AbstractNodeDocument): ColorInformation[] => {
    const colors: ColorInformation[] = [];
    for (const found of markupColorTags(document)) {
        const color = colorOfTag(found.tag);
        if (!color) continue;
        colors.push({
            range: tagRange(found),
            color: { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha },
        });
    }
    return colors;
};

/** A channel of the picked colour as the game reads it, a whole number between 0 and 255. */
const byteOf = (channel: number): number => Math.round(Math.min(1, Math.max(0, channel)) * 255);

/** The picked colour as the six or eight hex digits `IntColor.FromHex` reads. */
const hexOf = (color: Color): string => {
    const digits = (channel: number) => byteOf(channel).toString(16).toUpperCase().padStart(2, '0');
    const rgb = digits(color.red) + digits(color.green) + digits(color.blue);
    return color.alpha >= 1 ? rgb : rgb + digits(color.alpha);
};

/**
 * The colour name the picked colour is exactly, so a tag written `name='Red'` keeps its name form
 * when the picker lands back on a named colour.
 *
 * @param color the picked colour.
 * @returns the name, or undefined when no named colour matches.
 */
const nameOf = (color: Color): string | undefined => {
    for (const [name, channels] of NAMED_COLORS) {
        if (
            byteOf(channels[0]) === byteOf(color.red) &&
            byteOf(channels[1]) === byteOf(color.green) &&
            byteOf(channels[2]) === byteOf(color.blue) &&
            byteOf(channels[3]) === byteOf(color.alpha)
        ) {
            return name;
        }
    }
    return undefined;
};

/**
 * The tag text the picked colour is written back as, in the form the author wrote the tag in. A
 * `name` form that no longer names a colour becomes a `hex` one, which is the only other form that
 * writes a colour in a single attribute.
 *
 * @param tag the tag as written.
 * @param color the colour the user picked.
 * @returns the whole replacement tag, angle brackets included.
 */
const rewrittenTag = (tag: MarkupTag, color: Color): string => {
    const quote = tag.attributes[0]?.quote ?? "'";
    const written = (name: string, value: string) => `${name}=${quote}${value}${quote}`;
    const hasAlpha = color.alpha < 1 || tag.attributes.some((attribute) => attribute.name === 'a');
    const attributes = (() => {
        if (tag.attributes.some((attribute) => attribute.name === 'hex')) return [written('hex', hexOf(color))];
        if (tag.attributes.some((attribute) => attribute.name === 'name')) {
            const name = nameOf(color);
            return [name ? written('name', name) : written('hex', hexOf(color))];
        }
        const channels = [
            written('r', String(byteOf(color.red))),
            written('g', String(byteOf(color.green))),
            written('b', String(byteOf(color.blue))),
        ];
        return hasAlpha ? [...channels, written('a', String(byteOf(color.alpha)))] : channels;
    })();
    return `<${tag.name} ${attributes.join(' ')}${tag.selfClosing ? '/>' : '>'}`;
};

/**
 * The picker presentation for a colour tag: one edit that rewrites the whole tag, keeping its
 * element name and the form its colour was written in.
 *
 * @param document the parsed language file.
 * @param range the colour range the client sent back.
 * @param color the colour the user picked.
 * @returns one presentation, or an empty list when the range is no colour tag of this file.
 */
export const markupColorPresentations = (
    document: AbstractNodeDocument,
    range: Range,
    color: Color
): ColorPresentation[] => {
    for (const found of markupColorTags(document)) {
        const bounds = tagRange(found);
        if (bounds.start.line !== range.start.line || bounds.start.character !== range.start.character) continue;
        const text = rewrittenTag(found.tag, color);
        return [{ label: text, textEdit: TextEdit.replace(bounds, text) }];
    }
    return [];
};
