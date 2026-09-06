import { CompletionItemKind, Position, Range } from 'vscode-languageserver';
import { normalizeUri } from '../navigation/reference-location';
import {
    allowedValuesOf,
    H_ALIGNMENTS,
    MARKUP_TAGS,
    NAMED_COLORS,
    STRICT_BOOLEANS,
    tagSpecOf,
    V_ALIGNMENTS,
} from '../text-markup/text-markup';
import { AttributeSpec, TagSpec } from '../text-markup/text-markup.types';
import { Completion } from './autocompletion.service';

/**
 * Completion for the markup a language file's strings carry. The text the game draws is read as an
 * XML fragment first, and its vocabulary is closed: an element the reader does not know makes the
 * game drop the markup of the whole string. Offering that vocabulary is therefore the difference
 * between writing markup from memory and writing it from the engine.
 *
 * Driven off the written line rather than off the syntax tree, because a half-typed `<col` inside a
 * string is a value the parser is still holding as plain text.
 */
const STRINGS_PATH_SEGMENT = /(^|\/)strings\//;

/** How far back a tag is looked for, which is the line the cursor sits on. */
const MAX_TAG_LENGTH = 4000;

/** What the cursor sits in, which decides what is offered. */
export interface MarkupCompletionContext {
    /** The completions themselves. */
    readonly completions: Completion[];
    /**
     * Whether this position takes a localization key, which the caller answers from the project's
     * strings index.
     */
    readonly localizationKeys: boolean;
    /**
     * Whether this position takes an image name, which the caller answers from the images the
     * project registers.
     */
    readonly imageNames: boolean;
    /** The text the insert replaces, which is what the author has typed of the word so far. */
    readonly range: Range;
}

/** The named colours as completions, each carrying its own swatch. */
const namedColorCompletions = (): Completion[] =>
    [...NAMED_COLORS].map(([name, channels]) => ({
        label: name,
        kind: CompletionItemKind.Color,
        documentation:
            '#' +
            channels
                .slice(0, 3)
                .map((channel) => Math.round(channel * 255).toString(16).toUpperCase().padStart(2, '0'))
                .join(''),
    }));

/**
 * The values an attribute takes, where the engine takes a closed set of them.
 *
 * @param attribute the attribute the cursor sits in the value of.
 * @returns the completions, empty where the value is free text.
 */
const attributeValueCompletions = (attribute: AttributeSpec): Completion[] => {
    switch (attribute.kind) {
        case 'colorName':
            return namedColorCompletions();
        case 'hAlignment':
            return H_ALIGNMENTS.map((name) => ({ label: name, kind: CompletionItemKind.EnumMember }));
        case 'vAlignment':
            return V_ALIGNMENTS.map((name) => ({ label: name, kind: CompletionItemKind.EnumMember }));
        case 'lenientBoolean':
        case 'strictBoolean':
            return STRICT_BOOLEANS.map((name) => ({ label: name, kind: CompletionItemKind.Value }));
        default:
            return (allowedValuesOf(attribute.kind) ?? []).map((name) => ({
                label: name,
                kind: CompletionItemKind.Value,
            }));
    }
};

/**
 * The insert for an element, which closes the element it wraps text with and opens the attribute it
 * cannot be written without.
 *
 * @param spec the element to insert.
 * @returns the snippet, without the `<` the author has already typed.
 */
const tagInsert = (spec: TagSpec): string => {
    const required = spec.attributes.find((attribute) => attribute.required);
    const opening = required ? `${spec.name} ${required.name}='\${1}'` : spec.name;
    if (!spec.wrapsText) return `${opening}/>`;
    return required ? `${opening}>\${2}</${spec.name}>` : `${opening}>\${1}</${spec.name}>`;
};

/** Every element the markup reader knows, as completions that close themselves. */
const tagCompletions = (): Completion[] =>
    MARKUP_TAGS.filter((spec) => !spec.unusable).map((spec) => ({
        label: spec.name,
        kind: CompletionItemKind.Keyword,
        detail: spec.detail,
        insertText: tagInsert(spec),
        isSnippet: true,
    }));

/**
 * The element a closing tag would close: the innermost one still open in front of the cursor.
 *
 * @param before the written text in front of the cursor.
 * @returns the element name, or undefined when nothing is open.
 */
const openElementBefore = (before: string): string | undefined => {
    const open: string[] = [];
    const tags = /<(\/?)([A-Za-z_:][A-Za-z0-9_.:-]*)([^>]*?)(\/?)>/g;
    for (let match = tags.exec(before); match; match = tags.exec(before)) {
        const [, closing, name, , selfClosing] = match;
        if (closing) open.pop();
        else if (!selfClosing) open.push(name);
    }
    return open[open.length - 1];
};

/**
 * The completions for the markup position the cursor sits at, or undefined when it sits in no tag.
 *
 * Four positions are answered: an element name after a `<`, the element a `</` closes, an attribute
 * name inside an open tag, and an attribute value inside its quotes.
 *
 * @param uri the document the cursor is in, which has to be a language file.
 * @param linePrefix the line up to the cursor.
 * @param position the cursor position, which the replace range is measured from.
 * @returns what to offer, or undefined when this is no markup position.
 */
export const markupCompletionsAt = (
    uri: string,
    linePrefix: string,
    position: Position
): MarkupCompletionContext | undefined => {
    if (!STRINGS_PATH_SEGMENT.test(normalizeUri(uri))) return undefined;
    const searched = linePrefix.slice(-MAX_TAG_LENGTH);
    const opened = searched.lastIndexOf('<');
    if (opened < 0) return undefined;
    const tag = searched.slice(opened);
    if (tag.includes('>')) return undefined;
    /** The range the typed word occupies, which the insert replaces. */
    const replacing = (typed: string): Range =>
        Range.create(Position.create(position.line, Math.max(0, position.character - typed.length)), position);

    const closing = /^<\/([A-Za-z0-9_.:-]*)$/.exec(tag);
    if (closing) {
        const open = openElementBefore(searched.slice(0, opened));
        if (!open) return undefined;
        return {
            completions: [{ label: open, kind: CompletionItemKind.Keyword, insertText: open + '>' }],
            localizationKeys: false,
            imageNames: false,
            range: replacing(closing[1]),
        };
    }
    const naming = /^<([A-Za-z0-9_.:-]*)$/.exec(tag);
    if (naming) {
        return { completions: tagCompletions(), localizationKeys: false, imageNames: false, range: replacing(naming[1]) };
    }
    const inside = /^<([A-Za-z_:][A-Za-z0-9_.:-]*)\s([\s\S]*)$/.exec(tag);
    if (!inside) return undefined;
    const spec = tagSpecOf(inside[1]);
    if (!spec) return undefined;
    const written = inside[2];
    const inValue = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(['"])([^'"]*)$/.exec(written);
    if (inValue) {
        const attribute = spec.attributes.find((known) => known.name === inValue[1]);
        if (!attribute) return undefined;
        return {
            completions: attributeValueCompletions(attribute),
            localizationKeys: attribute.kind === 'localizationKey',
            imageNames: attribute.kind === 'imageName',
            range: replacing(inValue[3]),
        };
    }
    const typed = /([A-Za-z0-9_.:-]*)$/.exec(written)?.[1] ?? '';
    // An attribute already written is not offered again: a second one of the same name is what the
    // reader throws on.
    const present = new Set(
        [...written.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=/g)].map((match) => match[1].toLowerCase())
    );
    const offered = spec.attributes.filter(
        (attribute) => !present.has(attribute.name.toLowerCase()) || attribute.name.toLowerCase() === typed.toLowerCase()
    );
    if (offered.length === 0) return undefined;
    return {
        completions: offered.map((attribute) => ({
            label: attribute.name,
            kind: CompletionItemKind.Property,
            detail: attribute.detail,
            insertText: `${attribute.name}='\${1}'`,
            isSnippet: true,
            sortText: (attribute.required ? '0' : '1') + attribute.name,
        })),
        localizationKeys: false,
        imageNames: false,
        range: replacing(typed),
    };
};
