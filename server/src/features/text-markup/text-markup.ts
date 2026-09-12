import { ValueNode } from '../../core/ast/ast';
import {
    AttributeSpec,
    AttributeValueKind,
    MarkupAttribute,
    MarkupColor,
    MarkupFault,
    MarkupIssue,
    MarkupScan,
    MarkupSpan,
    MarkupTag,
    TagSpec,
} from './text-markup.types';

/**
 * The markup language the game draws text with, read from `Halfling.Graphics.Text.TextBuilder` and
 * the handlers `Cosmoteer.GameApp` registers on it.
 *
 * Every string the game draws is first read as an XML fragment. An element the reader does not know,
 * an attribute it needs and cannot find, or a value it cannot parse all throw, and the throw is
 * caught by re-drawing the string with no markup at all, so the player sees the tags themselves.
 * Nothing is logged. This module is the single description of that language: the tag vocabulary, the
 * attributes each tag reads, and a scanner that walks a written string the way the reader does.
 *
 * Names are matched the way the engine matches them. The built-in elements go through
 * `ToLowerInvariant`, colour names and the `s14` size form are case-insensitive, and the handler
 * table `GameApp` fills is an ordinal dictionary, so `<PlatformCmdCtrl>` and `<good>` are
 * case-sensitive.
 */

/** The alignment enums the align elements parse their value against. */
export const H_ALIGNMENTS = ['Left', 'Center', 'Right'] as const;
export const V_ALIGNMENTS = ['Top', 'Center', 'Bottom'] as const;

/** The words `TextBuilder.ParseBool` accepts, and the two `bool.Parse` accepts. */
export const LENIENT_BOOLEANS = ['true', 'yes', '1', 'y', 'false', 'no', '0', 'n'] as const;
export const STRICT_BOOLEANS = ['true', 'false'] as const;

/**
 * `Halfling.Graphics.Color.NamedColors`, the public static colour fields of `Color` reflected into a
 * case-insensitive table. Each is both a tag of its own (`<green>Ready</green>`) and a legal value
 * for the `name` attribute of `<color>` and `<background>`.
 */
export const NAMED_COLORS: ReadonlyMap<string, readonly [number, number, number, number]> = new Map([
    ['Zero', [0, 0, 0, 0] as const],
    ['Black', [0, 0, 0, 1] as const],
    ['Red', [1, 0, 0, 1] as const],
    ['Green', [0, 1, 0, 1] as const],
    ['Blue', [0, 0, 1, 1] as const],
    ['Yellow', [1, 1, 0, 1] as const],
    ['Orange', [1, 0.5, 0, 1] as const],
    ['Magenta', [1, 0, 1, 1] as const],
    ['Cyan', [0, 1, 1, 1] as const],
    ['White', [1, 1, 1, 1] as const],
    ['Gray', [0.5, 0.5, 0.5, 1] as const],
    ['TransparentWhite', [1, 1, 1, 0] as const],
]);

/** The colour attributes `TextBuilder.ParseColor` reads, in the order it tries them. */
const COLOR_ATTRIBUTES: readonly AttributeSpec[] = [
    { name: 'hex', kind: 'hexColor', detail: 'RRGGBB or RRGGBBAA' },
    { name: 'name', kind: 'colorName', detail: 'a named colour' },
    { name: 'r', kind: 'number', detail: 'red, 0 to 255' },
    { name: 'g', kind: 'number', detail: 'green, 0 to 255' },
    { name: 'b', kind: 'number', detail: 'blue, 0 to 255' },
    { name: 'a', kind: 'number', detail: 'alpha, 0 to 255, opaque when absent' },
];

/** The optional `enable` attribute every font-style toggle reads. */
const ENABLE: readonly AttributeSpec[] = [{ name: 'enable', kind: 'lenientBoolean', detail: 'off with false' }];

/** The attributes both spellings of the inline image element read. */
const IMAGE_ATTRIBUTES: readonly AttributeSpec[] = [
    { name: 'name', kind: 'imageName', required: true, detail: 'an image the project registers' },
    { name: 'w', kind: 'integer', detail: 'width in pixels' },
    { name: 'width', kind: 'integer', detail: 'width in pixels' },
    { name: 'h', kind: 'integer', detail: 'height in pixels' },
    { name: 'height', kind: 'integer', detail: 'height in pixels' },
    { name: 'colored', kind: 'strictBoolean', detail: 'tint it with the text colour' },
];

/** The elements `TextBuilder` handles itself, matched lowercased. */
const BUILTIN_TAGS: readonly TagSpec[] = [
    {
        name: 'font',
        wrapsText: true,
        detail: 'Draws the text in a named font.',
        // `TextAssetLibrary.AddFont` exists and nothing in the game ever calls it, so the font table
        // is empty and the lookup this tag makes always throws.
        unusable: 'the game registers no fonts at all',
        attributes: [{ name: 'name', kind: 'text', required: true, detail: 'a font of the text asset library' }],
    },
    {
        name: 'size',
        wrapsText: true,
        detail: 'Sets the font size in pixels.',
        attributes: [{ name: 'value', kind: 'integer', required: true }],
    },
    {
        name: 'z',
        wrapsText: true,
        detail: 'Sets the depth the text is drawn at.',
        attributes: [{ name: 'value', kind: 'number', required: true }],
    },
    {
        name: 'zdepth',
        wrapsText: true,
        detail: 'Sets the depth the text is drawn at.',
        attributes: [{ name: 'value', kind: 'number', required: true }],
    },
    {
        name: 'monospace',
        wrapsText: true,
        detail: 'Gives every character the width of one character.',
        attributes: [{ name: 'char', kind: 'character', detail: 'the character to take the width from' }],
    },
    { name: 'sup', wrapsText: true, detail: 'Superscript.', attributes: [] },
    { name: 'sub', wrapsText: true, detail: 'Subscript.', attributes: [] },
    { name: 'color', wrapsText: true, detail: 'Sets the text colour.', attributes: COLOR_ATTRIBUTES },
    { name: 'background', wrapsText: true, detail: 'Sets the colour behind the text.', attributes: COLOR_ATTRIBUTES },
    { name: 'b', wrapsText: true, detail: 'Bold.', attributes: ENABLE },
    { name: 'bold', wrapsText: true, detail: 'Bold.', attributes: ENABLE },
    { name: 'i', wrapsText: true, detail: 'Italic.', attributes: ENABLE },
    { name: 'italic', wrapsText: true, detail: 'Italic.', attributes: ENABLE },
    { name: 'u', wrapsText: true, detail: 'Underline.', attributes: ENABLE },
    { name: 'underline', wrapsText: true, detail: 'Underline.', attributes: ENABLE },
    { name: 's', wrapsText: true, detail: 'Strikeout.', attributes: ENABLE },
    { name: 'strike', wrapsText: true, detail: 'Strikeout.', attributes: ENABLE },
    { name: 'nostyle', wrapsText: true, detail: 'Drops bold, italic, underline and strikeout.', attributes: [] },
    {
        name: 'halign',
        wrapsText: true,
        detail: 'Horizontal alignment.',
        attributes: [{ name: 'value', kind: 'hAlignment', required: true }],
    },
    {
        name: 'valign',
        wrapsText: true,
        detail: 'Vertical alignment of the line.',
        attributes: [{ name: 'value', kind: 'vAlignment', required: true }],
    },
    {
        name: 'ialign',
        wrapsText: true,
        detail: 'Vertical alignment inside the line.',
        attributes: [{ name: 'value', kind: 'vAlignment', required: true }],
    },
    { name: 'img', wrapsText: false, detail: 'Draws an image inline.', attributes: IMAGE_ATTRIBUTES },
    { name: 'image', wrapsText: false, detail: 'Draws an image inline.', attributes: IMAGE_ATTRIBUTES },
];

/** The handlers `GameApp.InitializeCustomXmlHandlers` registers, keyed ordinally. */
const CUSTOM_TAGS: readonly TagSpec[] = [
    {
        name: 'string',
        caseSensitive: true,
        wrapsText: false,
        detail: 'Draws another localized string in place.',
        attributes: [{ name: 'id', kind: 'localizationKey', required: true, detail: 'the key to draw' }],
    },
    {
        name: 'btn',
        caseSensitive: true,
        wrapsText: false,
        detail: 'Draws the key or button bound to an input.',
        attributes: [
            { name: 'id', kind: 'text', required: true, detail: 'an input, written Group.Name' },
            { name: 'xml', kind: 'strictBoolean', detail: 'colour it, on by default' },
        ],
    },
    {
        name: 'PlatformCmdCtrl',
        caseSensitive: true,
        wrapsText: false,
        detail: 'Draws Ctrl, or Cmd on macOS.',
        attributes: [],
    },
    { name: 'copyright_year', caseSensitive: true, wrapsText: false, detail: 'Draws the build year.', attributes: [] },
    { name: 'good', caseSensitive: true, wrapsText: true, detail: 'The good text colour.', attributes: [] },
    { name: 'bad', caseSensitive: true, wrapsText: true, detail: 'The bad text colour.', attributes: [] },
    { name: 'regular', caseSensitive: true, wrapsText: true, detail: 'The ordinary label colour.', attributes: [] },
    { name: 'money_color', caseSensitive: true, wrapsText: true, detail: 'The money colour.', attributes: [] },
    { name: 'money', caseSensitive: true, wrapsText: true, detail: 'A money icon and the amount.', attributes: [] },
    { name: 'add_money', caseSensitive: true, wrapsText: true, detail: 'A money amount with a plus.', attributes: [] },
    {
        name: 'ins_money',
        caseSensitive: true,
        wrapsText: true,
        detail: 'A money amount in the cannot-afford colour.',
        attributes: [],
    },
    {
        name: 'refund_money',
        caseSensitive: true,
        wrapsText: true,
        detail: 'A refunded money amount.',
        attributes: [],
    },
    { name: 'fame_color', caseSensitive: true, wrapsText: true, detail: 'The fame colour.', attributes: [] },
    { name: 'fame', caseSensitive: true, wrapsText: true, detail: 'A fame icon and the amount.', attributes: [] },
    {
        name: 'ins_fame',
        caseSensitive: true,
        wrapsText: true,
        detail: 'A fame amount in the cannot-afford colour.',
        attributes: [],
    },
    {
        name: 'limited_color',
        caseSensitive: true,
        wrapsText: true,
        detail: 'The limited-stock colour.',
        attributes: [],
    },
    { name: 'player', caseSensitive: true, wrapsText: true, detail: 'The local player colour.', attributes: [] },
    { name: 'enemy', caseSensitive: true, wrapsText: true, detail: 'The enemy colour.', attributes: [] },
    { name: 'ally', caseSensitive: true, wrapsText: true, detail: 'The ally colour.', attributes: [] },
    { name: 'neutral', caseSensitive: true, wrapsText: true, detail: 'The neutral colour.', attributes: [] },
    {
        name: 'owned_bright',
        caseSensitive: true,
        wrapsText: true,
        detail: 'The local player colour, brightened.',
        attributes: [],
    },
    {
        name: 'enemy_bright',
        caseSensitive: true,
        wrapsText: true,
        detail: 'The enemy colour, brightened.',
        attributes: [],
    },
    {
        name: 'ally_bright',
        caseSensitive: true,
        wrapsText: true,
        detail: 'The ally colour, brightened.',
        attributes: [],
    },
    {
        name: 'neutral_bright',
        caseSensitive: true,
        wrapsText: true,
        detail: 'The neutral colour, brightened.',
        attributes: [],
    },
];

/** The `s14` form, a font size written as the tag itself. */
const SIZE_TAG = /^s([0-9]+)$/i;

/** Every element name the reader knows, the named colours and the size form included. */
export const MARKUP_TAGS: readonly TagSpec[] = [
    ...BUILTIN_TAGS,
    ...CUSTOM_TAGS,
    ...[...NAMED_COLORS.keys()].map((name): TagSpec => ({
        name,
        wrapsText: true,
        detail: 'The colour ' + name.toLowerCase() + '.',
        attributes: [],
    })),
];

/**
 * The specification of a written element name, matched the way the engine matches it.
 *
 * @param name the element name as written.
 * @returns the specification, or undefined when the reader knows no such element.
 */
export const tagSpecOf = (name: string): TagSpec | undefined => {
    const lowered = name.toLowerCase();
    const builtin = BUILTIN_TAGS.find((tag) => tag.name === lowered);
    if (builtin) return builtin;
    for (const [colorName] of NAMED_COLORS) {
        if (colorName.toLowerCase() === lowered) {
            return {
                name: colorName,
                wrapsText: true,
                detail: 'The colour ' + colorName.toLowerCase() + '.',
                attributes: [],
            };
        }
    }
    if (SIZE_TAG.test(name)) {
        return { name, wrapsText: true, detail: 'A font size in pixels.', attributes: [] };
    }
    return CUSTOM_TAGS.find((tag) => tag.name === name);
};

/** A name an element or an attribute can carry, in the shape XML allows, anchored at a position. */
const NAME_AT = /[A-Za-z_:][A-Za-z0-9_.:-]*/y;

/** A character reference, which is the one thing an `&` is allowed to start. */
const ENTITY_AT = /&(#\d+|#x[0-9A-Fa-f]+|[A-Za-z_:][A-Za-z0-9_.:-]*);/y;

/** Anything tag-shaped, which is what makes a string one the markup reader's verdict is felt on. */
const TAG_SHAPED = /<\/?[A-Za-z_:]/;

/**
 * The character a backslash escape stands for. The game's own reader unescapes a value before
 * anything reads it, so a `\"` inside an attribute is a quote to the markup parser.
 *
 * @param character the character the backslash was written in front of.
 * @returns the character the pair stands for.
 */
const escapedCharacter = (character: string): string =>
    character === 'n' ? '\n' : character === 't' ? '\t' : character === 'r' ? '\r' : character;

/**
 * The written text as the markup reader sees it, with the offset every character was written at so a
 * finding or a swatch can point back at the text the author typed.
 */
interface ReaderText {
    /** The characters the reader sees, escapes resolved. */
    readonly text: string;
    /** For each of them, the offset it was written at. */
    readonly at: number[];
    /** For each of them, the length it was written with, two for an escaped character. */
    readonly width: number[];
}

/**
 * Resolves the escapes of a written value, keeping the written offset of every character.
 *
 * @param written the value as the lexer kept it, escapes intact.
 * @returns the text the reader sees, with the written offset and width of each character.
 */
const readerTextOf = (written: string): ReaderText => {
    let text = '';
    const at: number[] = [];
    const width: number[] = [];
    for (let index = 0; index < written.length; index++) {
        if (written[index] === '\\' && index + 1 < written.length) {
            text += escapedCharacter(written[index + 1]);
            at.push(index);
            width.push(2);
            index++;
            continue;
        }
        text += written[index];
        at.push(index);
        width.push(1);
    }
    return { text, at, width };
};

/** What a tag scan produced: the tag and the index past it, or the fault that stopped it. */
type TagResult = { tag: MarkupTag; next: number } | { fault: MarkupFault };

/**
 * Reads one tag, starting at its `<`.
 *
 * @param reader the string as the markup reader sees it.
 * @param start the index of the `<`.
 * @param writtenLength the length of the written text, for a span that runs to its end.
 * @returns the tag and where reading continues, or the fault that stopped it.
 */
const readTag = (reader: ReaderText, start: number, writtenLength: number): TagResult => {
    const { text, at, width } = reader;
    /** The written offset one past the character at `index`. */
    const endOf = (index: number) => (index < text.length ? at[index] + width[index] : writtenLength);
    /** The written offset of the character at `index`. */
    const startOf = (index: number) => (index < text.length ? at[index] : writtenLength);
    /** The name written at `index`, or undefined when no name starts there. */
    const nameAt = (index: number) => {
        NAME_AT.lastIndex = index;
        return NAME_AT.exec(text)?.[0];
    };
    const isSpace = (index: number) => index < text.length && /\s/.test(text[index]);

    let index = start + 1;
    const closing = text[index] === '/';
    if (closing) index++;
    const name = nameAt(index);
    if (!name) {
        return { fault: { kind: 'lessThan', detail: '<', start: startOf(start), end: endOf(start) } };
    }
    const nameStart = startOf(index);
    index += name.length;
    const nameEnd = endOf(index - 1);
    if (closing) {
        while (isSpace(index)) index++;
        if (text[index] !== '>') {
            return { fault: { kind: 'stray', detail: name, start: startOf(start), end: endOf(index) } };
        }
        return {
            tag: {
                name,
                nameStart,
                nameEnd,
                start: startOf(start),
                end: endOf(index),
                closing: true,
                selfClosing: false,
                attributes: [],
            },
            next: index + 1,
        };
    }
    const attributes: MarkupAttribute[] = [];
    const seen = new Set<string>();
    for (;;) {
        while (isSpace(index)) index++;
        if (index >= text.length) {
            return { fault: { kind: 'unclosed', detail: name, start: startOf(start), end: writtenLength } };
        }
        const selfClosing = text[index] === '/' && text[index + 1] === '>';
        if (selfClosing || text[index] === '>') {
            const last = selfClosing ? index + 1 : index;
            return {
                tag: {
                    name,
                    nameStart,
                    nameEnd,
                    start: startOf(start),
                    end: endOf(last),
                    closing: false,
                    selfClosing,
                    attributes,
                },
                next: last + 1,
            };
        }
        const attributeIndex = index;
        const attribute = nameAt(index);
        if (!attribute) {
            return { fault: { kind: 'attribute', detail: name, start: startOf(index), end: endOf(index) } };
        }
        index += attribute.length;
        const attributeNameEnd = endOf(index - 1);
        if (seen.has(attribute.toLowerCase())) {
            return {
                fault: {
                    kind: 'duplicateAttribute',
                    detail: attribute,
                    start: startOf(attributeIndex),
                    end: attributeNameEnd,
                },
            };
        }
        seen.add(attribute.toLowerCase());
        while (isSpace(index)) index++;
        if (text[index] !== '=') {
            return {
                fault: { kind: 'attribute', detail: attribute, start: startOf(attributeIndex), end: attributeNameEnd },
            };
        }
        index++;
        while (isSpace(index)) index++;
        const quote = text[index];
        if (quote !== '"' && quote !== "'") {
            return {
                fault: { kind: 'attribute', detail: attribute, start: startOf(attributeIndex), end: endOf(index) },
            };
        }
        const quoteIndex = index;
        let cursor = index + 1;
        while (cursor < text.length && text[cursor] !== quote) cursor++;
        if (cursor >= text.length) {
            return {
                fault: { kind: 'attribute', detail: attribute, start: startOf(attributeIndex), end: writtenLength },
            };
        }
        attributes.push({
            name: attribute,
            value: text.slice(quoteIndex + 1, cursor),
            nameStart: startOf(attributeIndex),
            nameEnd: attributeNameEnd,
            valueStart: endOf(quoteIndex),
            valueEnd: startOf(cursor),
            quote: width[quoteIndex] === 2 ? '\\' + quote : quote,
        });
        index = cursor + 1;
    }
};

/**
 * Reads a written string the way the game's markup reader does, collecting its tags and stopping at
 * the first thing that would make the reader throw.
 *
 * A string carrying nothing tag-shaped is never judged: it renders the same whether the reader
 * accepted it or not, so a `<` used as a less-than sign in prose is left alone.
 *
 * @param written the value as the lexer kept it, escapes intact.
 * @returns the tags that were read and the first fault, if any.
 */
export const scanMarkup = (written: string): MarkupScan => {
    if (!TAG_SHAPED.test(written)) return { hasMarkup: false, tags: [] };
    const reader = readerTextOf(written);
    const { text, at, width } = reader;
    const endOf = (index: number) => (index < text.length ? at[index] + width[index] : written.length);
    const startOf = (index: number) => (index < text.length ? at[index] : written.length);
    const tags: MarkupTag[] = [];
    const open: MarkupTag[] = [];
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (character === '&') {
            ENTITY_AT.lastIndex = index;
            const entity = ENTITY_AT.exec(text);
            if (!entity) {
                return {
                    hasMarkup: true,
                    tags,
                    fault: { kind: 'ampersand', detail: '&', start: startOf(index), end: endOf(index) },
                };
            }
            index += entity[0].length;
            continue;
        }
        if (character !== '<') {
            index++;
            continue;
        }
        if (text.startsWith('<!--', index)) {
            const closed = text.indexOf('-->', index + 4);
            if (closed < 0) {
                return {
                    hasMarkup: true,
                    tags,
                    fault: { kind: 'stray', detail: '<!--', start: startOf(index), end: written.length },
                };
            }
            index = closed + 3;
            continue;
        }
        const result = readTag(reader, index, written.length);
        if ('fault' in result) return { hasMarkup: true, tags, fault: result.fault };
        const { tag, next } = result;
        tags.push(tag);
        if (tag.closing) {
            const expected = open.pop();
            if (expected === undefined) {
                return {
                    hasMarkup: true,
                    tags,
                    fault: { kind: 'stray', detail: tag.name, start: tag.start, end: tag.end },
                };
            }
            // XML matches an end tag against its start tag by ordinal comparison, so a case that
            // differs is a mismatch even where the element name itself is matched case-insensitively.
            if (expected.name !== tag.name) {
                return {
                    hasMarkup: true,
                    tags,
                    fault: { kind: 'mismatched', detail: expected.name, start: tag.start, end: tag.end },
                };
            }
        } else if (!tag.selfClosing) {
            open.push(tag);
        }
        index = next;
    }
    if (open.length > 0) {
        const last = open[open.length - 1];
        return {
            hasMarkup: true,
            tags,
            fault: { kind: 'unclosed', detail: last.name, start: last.start, end: last.end },
        };
    }
    return { hasMarkup: true, tags };
};

/**
 * The text of a string value as it was written, with the document offset of its first character, so
 * that every offset a scan reports can be turned back into a span in the file. The lexer keeps a
 * value's text exactly as written, escapes and all, so the two run character for character and the
 * only thing to work out is how much of the literal the opening quote takes.
 *
 * @param node the string value node.
 * @returns the written text and where it starts, or undefined when the node carries no text.
 */
export const markupTextOf = (node: ValueNode): MarkupSpan | undefined => {
    if (node.valueType.type !== 'String') return undefined;
    const text = String(node.valueType.value);
    const { start, end } = node.position;
    const opening = end - start - text.length - (node.quoted ? 1 : 0);
    if (opening < 0) return undefined;
    return { text, offset: start + opening };
};

/** Whether a written value parses the way `float.Parse` with the invariant culture does. */
export const isNumberValue = (value: string): boolean => /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());

/** Whether a written value parses the way `int.Parse` does. */
export const isIntegerValue = (value: string): boolean => /^[+-]?\d+$/.test(value.trim());

/** Whether a written value is one `IntColor.FromHex` reads: six or eight hex digits, no leading hash. */
export const isHexColorValue = (value: string): boolean => /^[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(value);

/** The colour table keyed the way `Color.NamedColors` is keyed, which is case-insensitively. */
const NAMED_COLORS_LOWERCASE: ReadonlyMap<string, readonly [number, number, number, number]> = new Map(
    [...NAMED_COLORS].map(([name, channels]) => [name.toLowerCase(), channels])
);

/** The shape every colour name has, which rules out a whole translated sentence before it is copied. */
const COLOR_NAME_SHAPED = /^\s*[A-Za-z]{1,32}\s*$/;

/** The named colour a value names, matched case-insensitively as `Color.NamedColors` is keyed. */
export const namedColorOf = (value: string): readonly [number, number, number, number] | undefined =>
    COLOR_NAME_SHAPED.test(value) ? NAMED_COLORS_LOWERCASE.get(value.trim().toLowerCase()) : undefined;

/**
 * The colour a `<color>` or `<background>` tag sets, read the way `TextBuilder.ParseColor` reads it:
 * `hex` first, then `name`, then the `r`, `g`, `b` and `a` channels, each divided by 255 with a
 * missing channel black and a missing alpha opaque.
 *
 * @param tag the tag to read.
 * @returns the colour, or undefined when the tag is no colour tag or its value cannot be read.
 */
export const colorOfTag = (tag: MarkupTag): MarkupColor | undefined => {
    const name = tag.name.toLowerCase();
    if (tag.closing || (name !== 'color' && name !== 'background')) return undefined;
    const attribute = (wanted: string) => tag.attributes.find((a) => a.name === wanted);
    const hex = attribute('hex');
    if (hex) {
        if (!isHexColorValue(hex.value)) return undefined;
        const byteAt = (index: number) => parseInt(hex.value.substr(index * 2, 2), 16) / 255;
        return {
            red: byteAt(0),
            green: byteAt(1),
            blue: byteAt(2),
            alpha: hex.value.length === 8 ? byteAt(3) : 1,
            form: 'hex',
        };
    }
    const named = attribute('name');
    if (named) {
        const channels = namedColorOf(named.value);
        if (!channels) return undefined;
        return { red: channels[0], green: channels[1], blue: channels[2], alpha: channels[3], form: 'name' };
    }
    const channel = (wanted: string, fallback: number): number | undefined => {
        const written = attribute(wanted);
        if (!written) return fallback;
        if (!isNumberValue(written.value)) return undefined;
        const parsed = Number(written.value) / 255;
        return parsed < 0 ? 0 : parsed > 1 ? 1 : parsed;
    };
    const red = channel('r', 0);
    const green = channel('g', 0);
    const blue = channel('b', 0);
    const alpha = channel('a', 1);
    if (red === undefined || green === undefined || blue === undefined || alpha === undefined) return undefined;
    if (!tag.attributes.some((a) => ['r', 'g', 'b', 'a'].includes(a.name))) return undefined;
    return { red, green, blue, alpha, form: 'channels' };
};

/** The known names an unknown one is measured against, which is every element the reader takes. */
const knownTagNames = (): string[] => [...MARKUP_TAGS.map((tag) => tag.name)];

/**
 * The known name a written one differs from only in case, which is the whole story for the handler
 * table: it is keyed ordinally, so `<Good>` reaches nothing while `<good>` works.
 *
 * @param written the name as written.
 * @param known the names to look through.
 * @returns the known name, or undefined when none matches case-insensitively.
 */
const sameNameOtherCase = (written: string, known: readonly string[]): string | undefined =>
    known.find((name) => name !== written && name.toLowerCase() === written.toLowerCase());

/**
 * Whether a written attribute value is one the engine can read for its kind.
 *
 * @param value the value as written, escapes already resolved.
 * @param kind how the engine reads it.
 * @returns true when the engine parses it, false when the parse throws.
 */
const isReadableValue = (value: string, kind: AttributeValueKind): boolean => {
    switch (kind) {
        case 'integer':
            return isIntegerValue(value);
        case 'number':
            return isNumberValue(value);
        case 'lenientBoolean':
            return (LENIENT_BOOLEANS as readonly string[]).includes(value.toLowerCase());
        case 'strictBoolean':
            return (STRICT_BOOLEANS as readonly string[]).includes(value.trim().toLowerCase());
        case 'character':
            return value.length === 1;
        case 'hAlignment':
            return isIntegerValue(value) || H_ALIGNMENTS.some((name) => name.toLowerCase() === value.toLowerCase());
        case 'vAlignment':
            return isIntegerValue(value) || V_ALIGNMENTS.some((name) => name.toLowerCase() === value.toLowerCase());
        case 'colorName':
            return namedColorOf(value) !== undefined;
        case 'hexColor':
            return isHexColorValue(value);
        default:
            return true;
    }
};

/** The words a value of this kind may be, for a message that can name them. */
export const allowedValuesOf = (kind: AttributeValueKind): readonly string[] | undefined => {
    switch (kind) {
        case 'lenientBoolean':
            return STRICT_BOOLEANS;
        case 'strictBoolean':
            return STRICT_BOOLEANS;
        case 'hAlignment':
            return H_ALIGNMENTS;
        case 'vAlignment':
            return V_ALIGNMENTS;
        case 'colorName':
            return [...NAMED_COLORS.keys()];
        default:
            return undefined;
    }
};

/**
 * Everything one written tag gets wrong, judged against the element the markup reader would run.
 *
 * Attribute names are matched the way `XmlReader.GetAttribute` matches them, which is ordinally, so
 * an attribute whose case differs is one the element never sees.
 *
 * @param tag the tag as written.
 * @returns the issues, empty when the reader would take the tag as it stands.
 */
export const tagIssues = (tag: MarkupTag): MarkupIssue[] => {
    if (tag.closing) return [];
    const spec = tagSpecOf(tag.name);
    if (!spec) {
        return [
            {
                kind: 'unknownTag',
                name: tag.name,
                suggestion: sameNameOtherCase(tag.name, knownTagNames()),
                start: tag.nameStart,
                end: tag.nameEnd,
            },
        ];
    }
    const issues: MarkupIssue[] = [];
    if (spec.unusable) {
        issues.push({
            kind: 'unusableTag',
            name: spec.name,
            reason: spec.unusable,
            start: tag.nameStart,
            end: tag.nameEnd,
        });
    }
    for (const attribute of spec.attributes) {
        if (!attribute.required) continue;
        if (!tag.attributes.some((written) => written.name === attribute.name)) {
            issues.push({
                kind: 'missingAttribute',
                name: spec.name,
                attribute: attribute.name,
                start: tag.start,
                end: tag.end,
            });
        }
    }
    /** The colour attribute that decides the colour, the others on the tag being dead weight. */
    const colorWinner =
        spec.name === 'color' || spec.name === 'background'
            ? ['hex', 'name'].find((name) => tag.attributes.some((written) => written.name === name))
            : undefined;
    for (const written of tag.attributes) {
        const attribute = spec.attributes.find((known) => known.name === written.name);
        if (!attribute) {
            issues.push({
                kind: 'unknownAttribute',
                name: spec.name,
                attribute: written.name,
                suggestion: sameNameOtherCase(
                    written.name,
                    spec.attributes.map((known) => known.name)
                ),
                start: written.nameStart,
                end: written.nameEnd,
            });
            continue;
        }
        if (!isReadableValue(written.value, attribute.kind)) {
            issues.push({
                kind: 'badValue',
                attribute: written.name,
                expected: attribute.kind,
                allowed: allowedValuesOf(attribute.kind),
                start: written.valueStart,
                end: written.valueEnd,
            });
            continue;
        }
        if (colorWinner && written.name !== colorWinner) {
            issues.push({
                kind: 'ignoredAttribute',
                attribute: written.name,
                winner: colorWinner,
                start: written.nameStart,
                end: written.valueEnd + 1,
            });
        }
    }
    return issues;
};

/**
 * The editor position of a document offset that falls inside a written string value. A value written
 * across a line continuation still runs as one text, so the line of an offset past the break is the
 * value's own line plus the breaks in front of it.
 *
 * @param node the string value node the offset falls in.
 * @param span the value's written text and where it starts.
 * @param offset the document offset to place, inside the value's text.
 * @returns the zero-based line and character of that offset.
 */
export const markupPositionOf = (
    node: ValueNode,
    span: MarkupSpan,
    offset: number
): { line: number; character: number } => {
    const upTo = span.text.slice(0, Math.max(0, offset - span.offset));
    const breaks = upTo.split('\n').length - 1;
    if (breaks === 0) {
        return { line: node.position.line, character: node.position.characterStart + (offset - node.position.start) };
    }
    return { line: node.position.line + breaks, character: upTo.length - upTo.lastIndexOf('\n') - 1 };
};
