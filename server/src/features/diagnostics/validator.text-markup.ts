import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNodeDocument, isValueNode } from '../../core/ast/ast';
import { normalizeUri } from '../navigation/reference-location';
import { keyDeclarationsOf } from '../completion/localization-key.index';
import { findModRoot } from '../../mod/mod-root';
import { markupTextOf, scanMarkup, tagIssues } from '../text-markup/text-markup';
import {
    AttributeValueKind,
    MarkupAttribute,
    MarkupFault,
    MarkupIssue,
    MarkupTag,
} from '../text-markup/text-markup.types';
import { textImageNames } from '../text-markup/text-image.names';
import { ValidationError } from './validator';

/**
 * The folder a language file has to sit in for the game to read it. Deliberately narrower than the
 * localization index's own test, which also accepts a file by its `__Name` member: run over every
 * `.rules` file, the checks below would judge quoted paths and reference text as markup.
 */
const STRINGS_PATH_SEGMENT = /(^|\/)strings\//;

/**
 * What the fault says to the author, in the wording of the thing that went wrong.
 *
 * @param fault the fault the scan stopped on.
 * @returns the diagnostic message.
 */
const messageForFault = (fault: MarkupFault): string => {
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
 * How a value of this kind has to be written, as the half sentence that names it.
 *
 * @param kind the way the engine reads the value.
 * @returns the shape the value has to have.
 */
const shapeOf = (kind: AttributeValueKind): string => {
    switch (kind) {
        case 'integer':
            return l10n.t('a whole number');
        case 'number':
            return l10n.t('a number');
        case 'character':
            return l10n.t('a single character');
        case 'hexColor':
            return l10n.t('six or eight hex digits, written without a leading #');
        default:
            return l10n.t('a value the game can read');
    }
};

/**
 * What a wrong tag says to the author, in the wording of the thing that went wrong.
 *
 * @param issue the issue found on the tag.
 * @returns the diagnostic message.
 */
const messageForIssue = (issue: MarkupIssue): string => {
    switch (issue.kind) {
        case 'unusableTag':
            // One tag is in this state and its reason is its own sentence, so the wording says what
            // is really the matter rather than pasting a clause into a frame.
            return l10n.t(
                "Nothing in the game registers a font, so a '{0}' tag always makes it give up on this string and draw its tags as plain text.",
                issue.name
            );
        case 'unknownTag':
            return issue.suggestion
                ? l10n.t(
                      "The game draws no '{0}' tag, so it gives up on this string and draws its tags as plain text. Tag names are case-sensitive here, write '{1}'.",
                      issue.name,
                      issue.suggestion
                  )
                : l10n.t(
                      "The game draws no '{0}' tag, so it gives up on this string and draws its tags as plain text.",
                      issue.name
                  );
        case 'missingAttribute':
            return l10n.t(
                "The '{0}' tag needs a '{1}' attribute. Without it the game gives up on this string and draws its tags as plain text.",
                issue.name,
                issue.attribute
            );
        case 'badValue':
            return issue.allowed
                ? l10n.t(
                      "'{0}' takes one of {1} here, so the game gives up on this string and draws its tags as plain text.",
                      issue.attribute,
                      issue.allowed.join(', ')
                  )
                : l10n.t(
                      "'{0}' takes {1} here, so the game gives up on this string and draws its tags as plain text.",
                      issue.attribute,
                      shapeOf(issue.expected)
                  );
        case 'unknownAttribute':
            return issue.suggestion
                ? l10n.t(
                      "The '{0}' tag reads no '{1}' attribute. Attribute names are case-sensitive here, write '{2}'.",
                      issue.name,
                      issue.attribute,
                      issue.suggestion
                  )
                : l10n.t("The '{0}' tag reads no '{1}' attribute, so this has no effect.", issue.name, issue.attribute);
        case 'ignoredAttribute':
            return l10n.t(
                "'{0}' already sets the colour of this tag, so '{1}' has no effect.",
                issue.winner,
                issue.attribute
            );
    }
};

/**
 * The `name` attribute of an image tag, which is the one value only the project can judge.
 *
 * @param tag the tag as written.
 * @returns the attribute, or undefined when this is no image tag or it names nothing.
 */
const imageNameOf = (tag: MarkupTag): MarkupAttribute | undefined => {
    const name = tag.name.toLowerCase();
    if (tag.closing || (name !== 'img' && name !== 'image')) return undefined;
    const written = tag.attributes.find((attribute) => attribute.name === 'name');
    return written && written.value.trim() ? written : undefined;
};

/** Whether an issue keeps the game from reading the string at all, rather than being ignored. */
const isRefusal = (issue: MarkupIssue): boolean =>
    issue.kind === 'unknownTag' ||
    issue.kind === 'unusableTag' ||
    issue.kind === 'missingAttribute' ||
    issue.kind === 'badValue';

/**
 * Flags a localization string whose markup the game cannot read.
 *
 * Text the game draws goes through a markup reader first, and everything that reader throws is
 * caught and answered by drawing the string again with no markup at all. Nothing is logged. The
 * player sees the tags themselves, so a single unclosed tag turns a whole description into markup
 * on screen. Beside the shape of the fragment, each tag is judged against the element the reader
 * would run for it: an element it knows nothing about, an attribute it throws without, and a value
 * it cannot parse all end the same way. An attribute the element never reads is reported too, as
 * dead weight rather than as a refusal, since the game simply ignores it.
 *
 * Judged only on the language files of a mod, in the folder the game reads them from, and only on
 * a string carrying markup in the first place. A string with no tags renders the same whether the
 * reader accepted it or not, so nothing is said about one.
 *
 * @param document the parsed document to validate.
 * @param cancellationToken cancels the walk when the document changed under us.
 * @returns one finding per string the markup reader would refuse, plus the ignored attributes.
 */
export const validateTextMarkup = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
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
        const span = markupTextOf(node);
        if (!span) continue;
        const scan = scanMarkup(span.text);
        if (!scan.hasMarkup) continue;
        const at = (start: number, end: number) => ({ start: span.offset + start, end: span.offset + end });
        if (scan.fault) {
            errors.push({
                message: messageForFault(scan.fault),
                node,
                range: at(scan.fault.start, scan.fault.end),
                severity: 'warning',
            });
        }
        for (const tag of scan.tags) {
            // An image name is the one value the tag tables cannot judge on their own: the library it
            // is looked up in is filled from the project's own data, the game's text sprites plus one
            // per resource and per faction. Judged only where the project registers any, so a
            // workspace without the game tree says nothing rather than everything.
            const image = imageNameOf(tag);
            if (image) {
                const registered = await textImageNames(folderPaths, cancellationToken, document.uri).catch(
                    () => new Set<string>()
                );
                if (registered.size > 0 && !registered.has(image.value)) {
                    errors.push({
                        message: l10n.t(
                            "Nothing in this project registers an image named '{0}', so the game gives up on this string and draws its tags as plain text.",
                            image.value
                        ),
                        node,
                        range: at(image.valueStart, image.valueEnd),
                        severity: 'warning',
                    });
                }
            }
            for (const issue of tagIssues(tag)) {
                errors.push({
                    message: messageForIssue(issue),
                    node,
                    range: at(issue.start, issue.end),
                    severity: isRefusal(issue) ? 'warning' : 'hint',
                    unnecessary: !isRefusal(issue),
                });
            }
        }
    }
    return errors;
};
