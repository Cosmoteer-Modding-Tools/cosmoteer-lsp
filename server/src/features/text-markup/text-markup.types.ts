/**
 * The shapes the text markup module hands out: the vocabulary a tag is described with, the tags and
 * attributes a scan reads out of a written string, the faults and issues it reports, and the span and
 * colour the colour picker and the validators work on. The vocabulary itself and the scanner live in
 * `text-markup.ts`.
 */

/** How an attribute's value is read, which decides what a written value is judged against. */
export type AttributeValueKind =
    | 'text'
    /** `int.Parse`, so digits with an optional sign and nothing else. */
    | 'integer'
    /** `float.Parse` with the invariant culture. */
    | 'number'
    /** `TextBuilder.ParseBool`: true/yes/1/y and false/no/0/n. */
    | 'lenientBoolean'
    /** `bool.Parse`, which takes only true and false. */
    | 'strictBoolean'
    /** Exactly one character. */
    | 'character'
    /** A member of `Halfling.Graphics.Text.HAlignment`. */
    | 'hAlignment'
    /** A member of `Halfling.Graphics.Text.VAlignment`. */
    | 'vAlignment'
    /** A key of `Halfling.Graphics.Color.NamedColors`. */
    | 'colorName'
    /** `IntColor.FromHex`: six or eight hex digits, no leading hash. */
    | 'hexColor'
    /** A localization key, which the `<string>` handler resolves through `Strings.GetText`. */
    | 'localizationKey'
    /** A name of the text asset library's images, which the project's data registers. */
    | 'imageName';

/** One attribute a tag reads, and what the engine does when it is missing. */
export interface AttributeSpec {
    readonly name: string;
    readonly kind: AttributeValueKind;
    /** True when the engine throws without it, which drops the markup of the whole string. */
    readonly required?: boolean;
    /** What the attribute is for, shown in completion. */
    readonly detail?: string;
}

/** One element the markup reader knows, with the attributes it reads. */
export interface TagSpec {
    readonly name: string;
    /** Ordinal matching, for the handler table. The built-in elements are case-insensitive. */
    readonly caseSensitive?: boolean;
    readonly attributes: readonly AttributeSpec[];
    /** Whether the element wraps text (`<b>…</b>`) rather than standing alone (`<img …/>`). */
    readonly wrapsText: boolean;
    /** What the element does, shown in completion and hover. */
    readonly detail: string;
    /** Why the element can never work, for one the engine knows and nothing ever feeds. */
    readonly unusable?: string;
}

/** One attribute of a written tag, with the offsets of its name and of its value inside the quotes. */
export interface MarkupAttribute {
    readonly name: string;
    /** The value with its escapes resolved, which is what the markup reader sees. */
    readonly value: string;
    readonly nameStart: number;
    readonly nameEnd: number;
    readonly valueStart: number;
    readonly valueEnd: number;
    /** The quote as written, which is `\"` in a string that escapes its quotes. */
    readonly quote: string;
}

/** One written tag, with offsets into the text it was scanned from. */
export interface MarkupTag {
    readonly name: string;
    readonly start: number;
    readonly end: number;
    readonly nameStart: number;
    readonly nameEnd: number;
    readonly closing: boolean;
    readonly selfClosing: boolean;
    readonly attributes: readonly MarkupAttribute[];
}

/** What stops a string being a well-formed fragment, with the span it was found at. */
export interface MarkupFault {
    readonly kind: 'ampersand' | 'lessThan' | 'attribute' | 'duplicateAttribute' | 'unclosed' | 'mismatched' | 'stray';
    readonly detail: string;
    readonly start: number;
    readonly end: number;
}

/** The result of reading a written string as the game reads it. */
export interface MarkupScan {
    /** Whether the string carries anything tag-shaped, which is what makes the reader's verdict felt. */
    readonly hasMarkup: boolean;
    /** The tags read before the first fault, in document order. */
    readonly tags: readonly MarkupTag[];
    /** The first fault, absent when the string is a well-formed fragment. */
    readonly fault?: MarkupFault;
}

/** The written text of a string value, with the document offset it starts at. */
export interface MarkupSpan {
    readonly text: string;
    readonly offset: number;
}
/** A colour a `<color>` or `<background>` tag sets, as channels between 0 and 1. */
export interface MarkupColor {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
    readonly alpha: number;
    /** The form the tag was written in, which the colour picker writes back in. */
    readonly form: 'hex' | 'name' | 'channels';
}

/** Something a written tag gets wrong, with the span it was found at. */
export type MarkupIssue =
    /** An element the reader knows nothing about, which drops the markup of the whole string. */
    | { readonly kind: 'unknownTag'; readonly name: string; readonly suggestion?: string; readonly start: number; readonly end: number }
    /** An element the reader knows and nothing ever feeds, so its lookup always throws. */
    | { readonly kind: 'unusableTag'; readonly name: string; readonly reason: string; readonly start: number; readonly end: number }
    /** An attribute the element throws without. */
    | { readonly kind: 'missingAttribute'; readonly name: string; readonly attribute: string; readonly start: number; readonly end: number }
    /** A value the element cannot parse, which throws the same way a missing one does. */
    | {
          readonly kind: 'badValue';
          readonly attribute: string;
          readonly expected: AttributeValueKind;
          readonly allowed?: readonly string[];
          readonly start: number;
          readonly end: number;
      }
    /** An attribute the element never reads, which the game ignores. */
    | { readonly kind: 'unknownAttribute'; readonly name: string; readonly attribute: string; readonly suggestion?: string; readonly start: number; readonly end: number }
    /** A colour attribute another one on the same tag already decided, which the game ignores. */
    | { readonly kind: 'ignoredAttribute'; readonly attribute: string; readonly winner: string; readonly start: number; readonly end: number };
