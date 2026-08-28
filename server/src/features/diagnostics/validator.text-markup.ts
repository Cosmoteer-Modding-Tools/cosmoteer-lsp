import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, isValueNode } from '../../core/ast/ast';
import { normalizeUri } from '../navigation/reference-location';
import { keyDeclarationsOf } from '../completion/localization-key.index';
import { findModRoot } from '../../mod/mod-root';
import { ValidationError } from './validator';

/**
 * The folder a language file has to sit in for the game to read it. Deliberately narrower than the
 * localization index's own test, which also accepts a file by its `__Name` member: run over every
 * `.rules` file, the checks below would judge quoted paths and reference text as markup.
 */
const STRINGS_PATH_SEGMENT = /(^|\/)strings\//;

/** A name an element or an attribute can carry, in the shape XML allows. */
const NAME = /^[A-Za-z_:][A-Za-z0-9_.:-]*/;

/** A character reference, which is the one thing an `&` is allowed to start. */
const ENTITY = /^&(#\d+|#x[0-9A-Fa-f]+|[A-Za-z_:][A-Za-z0-9_.:-]*);/;

/** What is wrong with a string's markup, which decides the sentence the finding writes. */
type MarkupFault =
    | { readonly kind: 'ampersand' }
    | { readonly kind: 'lessThan' }
    | { readonly kind: 'attribute'; readonly detail: string }
    | { readonly kind: 'duplicateAttribute'; readonly detail: string }
    | { readonly kind: 'unclosed'; readonly detail: string }
    | { readonly kind: 'mismatched'; readonly detail: string }
    | { readonly kind: 'stray'; readonly detail: string };

/** Anything tag-shaped, which is what makes a string one the markup reader's verdict is felt on. */
const TAG_SHAPED = /<\/?[A-Za-z_:]/;

/** How far the scanner got and what it is holding. */
interface ScanState {
    /** The elements opened and not yet closed, innermost last. */
    readonly open: string[];
}

/**
 * Puts back the characters the lexer keeps as they were written. The game's own reader unescapes a
 * value before anything reads it, so a `\"` inside an attribute is a quote to the markup parser and
 * has to be one here too.
 *
 * @param text the value as the lexer kept it.
 * @returns the text the game would hand to its markup parser.
 */
const unescaped = (text: string): string =>
    text.replace(/\\(.)/g, (_, character: string) =>
        character === 'n' ? '\n' : character === 't' ? '\t' : character === 'r' ? '\r' : character
    );

/**
 * Reads one tag, starting at its `<`.
 *
 * @param text the whole string.
 * @param start the offset of the `<`.
 * @param state the elements opened so far, which this updates.
 * @returns the offset past the tag, or the fault that stopped it.
 */
const readTag = (text: string, start: number, state: ScanState): number | MarkupFault => {
    let index = start + 1;
    const closing = text[index] === '/';
    if (closing) index++;
    const name = NAME.exec(text.slice(index))?.[0];
    if (!name) return { kind: 'lessThan' };
    index += name.length;
    if (closing) {
        while (index < text.length && /\s/.test(text[index])) index++;
        if (text[index] !== '>') return { kind: 'stray', detail: name };
        const expected = state.open.pop();
        if (expected === undefined) return { kind: 'stray', detail: name };
        if (expected.toLowerCase() !== name.toLowerCase()) return { kind: 'mismatched', detail: expected };
        return index + 1;
    }
    const seen = new Set<string>();
    for (;;) {
        while (index < text.length && /\s/.test(text[index])) index++;
        if (index >= text.length) return { kind: 'unclosed', detail: name };
        if (text.startsWith('/>', index)) return index + 2;
        if (text[index] === '>') {
            state.open.push(name);
            return index + 1;
        }
        const attribute = NAME.exec(text.slice(index))?.[0];
        if (!attribute) return { kind: 'attribute', detail: name };
        if (seen.has(attribute.toLowerCase())) return { kind: 'duplicateAttribute', detail: attribute };
        seen.add(attribute.toLowerCase());
        index += attribute.length;
        while (index < text.length && /\s/.test(text[index])) index++;
        if (text[index] !== '=') return { kind: 'attribute', detail: attribute };
        index++;
        while (index < text.length && /\s/.test(text[index])) index++;
        const quote = text[index];
        if (quote !== '"' && quote !== "'") return { kind: 'attribute', detail: attribute };
        const end = text.indexOf(quote, index + 1);
        if (end < 0) return { kind: 'attribute', detail: attribute };
        index = end + 1;
    }
};

/**
 * The first thing about a string that stops it being a well-formed markup fragment.
 *
 * The game hands every string it draws to a fragment reader and catches whatever that throws,
 * falling back to drawing the string exactly as written. A string carrying nothing tag-shaped is
 * therefore never judged: it renders the same whether the reader accepted it or not, so a `<` used
 * as a less-than sign in plain prose costs the author nothing and is not worth a word.
 *
 * @param text the unescaped string.
 * @returns the fault, or undefined when the fragment is well formed.
 */
const markupFault = (text: string): MarkupFault | undefined => {
    if (!TAG_SHAPED.test(text)) return undefined;
    const state: ScanState = { open: [] };
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (character === '&') {
            const entity = ENTITY.exec(text.slice(index));
            if (!entity) return { kind: 'ampersand' };
            index += entity[0].length;
            continue;
        }
        if (character === '<') {
            if (text.startsWith('<!--', index)) {
                const end = text.indexOf('-->', index + 4);
                if (end < 0) return { kind: 'stray', detail: '<!--' };
                index = end + 3;
                continue;
            }
            const next = readTag(text, index, state);
            if (typeof next !== 'number') return next;
            index = next;
            continue;
        }
        index++;
    }
    if (state.open.length > 0) return { kind: 'unclosed', detail: state.open[state.open.length - 1] };
    return undefined;
};

/**
 * What the fault says to the author, in the wording of the thing that went wrong.
 *
 * @param fault the fault the scan stopped on.
 * @returns the diagnostic message.
 */
const messageFor = (fault: MarkupFault): string => {
    switch (fault.kind) {
        case 'ampersand':
            return l10n.t(
                "A bare '&' is not markup, so the game gives up on this string and draws its tags as plain text. Write it as '&amp;'."
            );
        case 'lessThan':
            return l10n.t(
                "A '<' that starts no tag makes the game give up on this string and draw its tags as plain text. Write it as '&lt;'."
            );
        case 'attribute':
            return l10n.t(
                "The '{0}' attribute needs a quoted value. Without one the game gives up on this string and draws its tags as plain text.",
                fault.detail
            );
        case 'duplicateAttribute':
            return l10n.t(
                "'{0}' is written twice on one tag, so the game gives up on this string and draws its tags as plain text.",
                fault.detail
            );
        case 'unclosed':
            return l10n.t(
                "The '{0}' tag is never closed, so the game gives up on this string and draws its tags as plain text.",
                fault.detail
            );
        case 'mismatched':
            return l10n.t(
                "This closes a tag other than '{0}', the one still open, so the game gives up on this string and draws its tags as plain text.",
                fault.detail
            );
        case 'stray':
            return l10n.t(
                "There is no '{0}' tag open here, so the game gives up on this string and draws its tags as plain text.",
                fault.detail
            );
    }
};

/**
 * Flags a localization string whose markup the game cannot read.
 *
 * Text the game draws goes through a markup reader first, and everything that reader throws is
 * caught and answered by drawing the string again with no markup at all. Nothing is logged. The
 * player sees the tags themselves, so a single unclosed tag turns a whole description into markup
 * on screen.
 *
 * Judged only on the language files of a mod, in the folder the game reads them from, and only on
 * a string carrying markup in the first place. A string with no tags renders the same whether the
 * reader accepted it or not, so nothing is said about one.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per string the markup reader would refuse.
 */
export const validateTextMarkup = async (
    document: AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (!STRINGS_PATH_SEGMENT.test(normalizeUri(document.uri))) return [];
    // The game's own translations are not the author's to fix, and a mod cannot ship a correction
    // for one, so only a mod's own language files are judged.
    if (!findModRoot(document.uri)) return [];

    const errors: ValidationError[] = [];
    for (const declaration of keyDeclarationsOf(document)) {
        if (cancellationToken.isCancellationRequested) return [];
        const node = declaration.node;
        if (declaration.text === undefined || !isValueNode(node)) continue;
        if (node.valueType.type === 'Reference') continue;
        const fault = markupFault(unescaped(declaration.text));
        if (!fault) continue;
        errors.push({ message: messageFor(fault), node, severity: 'warning' });
    }
    return errors;
};
