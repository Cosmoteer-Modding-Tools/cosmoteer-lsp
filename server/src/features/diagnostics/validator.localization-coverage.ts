import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isValueNode } from '../../core/ast/ast';
import {
    isEnglish,
    isStringsDocument,
    keyDeclarationsOf,
    languageOf,
    LocalizationKeyIndex,
} from '../completion/localization-key.index';
import { findModRoot } from '../../mod/mod-root';
import { uriToFsPath } from '../navigation/workspace-files';
import { ValidationError } from './validator';

/** A `{0}`, `{name}` or `{0:F1}` slot the game fills in when it renders the string. */
const PLACEHOLDER = /\{[^{}]+\}/g;

/** How many missing keys a finding names before it stops listing them. */
const LISTED_KEYS = 5;

/**
 * The placeholders a string carries, sorted so two strings can be compared whatever order they put
 * them in. A translation is free to move `{0}` in front of `{1}`, and only a slot that is dropped
 * or invented changes what the game renders.
 *
 * @param text the translated string.
 * @returns the placeholder slots it holds, sorted.
 */
const placeholdersOf = (text: string): string[] => (text.match(PLACEHOLDER) ?? []).sort();

/** The folder of a document, the scope one language is compared against the others in. */
const folderOf = (uri: string): string => uriToFsPath(uri).replace(/[/\\][^/\\]*$/, '');

/**
 * The node a whole-file finding is anchored on: the `__Name` member that opens every strings file,
 * falling back to whatever the file starts with.
 *
 * @param document the strings file.
 * @returns the node to underline, or undefined for an empty file.
 */
const fileAnchor = (document: AbstractNodeDocument): AbstractNode | undefined => {
    for (const element of document.elements) {
        if (isAssignmentNode(element) && element.left.name === '__Name') return element.left;
    }
    return document.elements[0];
};

/**
 * Reports what one language of a mod is missing against the languages beside it: keys the other
 * strings files in the same folder declare and this one does not, and a key whose translation drops
 * or invents one of the placeholder slots the English text carries.
 *
 * The game falls back to nothing when a key is missing from the language in play, so a player
 * reading that language sees the raw key path. A placeholder slot the translation lost is worse
 * still, since the number the sentence was about never reaches the screen.
 *
 * Scoped to the mod being edited and to one folder, on purpose. The game's own strings are not
 * complete either, and a language of the base game is nothing a mod author can fix, so a file
 * outside a mod is never judged.
 *
 * @param document the parsed strings file to validate.
 * @param folderPaths the project folders the strings index is built from.
 * @param cancellationToken cancellation for the index build.
 * @returns one hint for the keys this language is missing, and one warning per mismatched
 *          placeholder set.
 */
export const validateLocalizationCoverage = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (!isStringsDocument(document) || !findModRoot(document.uri)) return [];
    const language = languageOf(document);
    if (!language) return [];

    const languages = await LocalizationKeyIndex.instance.languageTextsUnder(
        folderOf(document.uri),
        folderPaths,
        cancellationToken
    );
    if (cancellationToken.isCancellationRequested || languages.length < 2) return [];

    const own = languages.find((entry) => entry.language === language);
    const others = languages.filter((entry) => entry.language !== language);
    if (!own) return [];

    const errors: ValidationError[] = [];
    const declared = new Set<string>();
    for (const key of own.texts.keys()) declared.add(key.toLowerCase());
    const missing: string[] = [];
    for (const other of others) {
        for (const key of other.texts.keys()) {
            if (declared.has(key.toLowerCase())) continue;
            declared.add(key.toLowerCase());
            missing.push(key);
        }
    }
    const anchor = fileAnchor(document);
    if (missing.length > 0 && anchor) {
        const listed = missing.slice(0, LISTED_KEYS).join(', ');
        errors.push({
            message: l10n.t(
                '{0} declares {1} key(s) fewer than the languages beside it. A player reading it sees the key path instead of a sentence.',
                language,
                missing.length
            ),
            node: anchor,
            severity: 'hint',
            additionalInfo:
                missing.length > LISTED_KEYS
                    ? l10n.t('Missing: {0} and {1} more.', listed, missing.length - LISTED_KEYS)
                    : l10n.t('Missing: {0}.', listed),
            data: { fillLanguageKeys: { language, count: missing.length } },
        });
    }

    // The English text is the one the translations were written from, so it is what decides which
    // slots a sentence is supposed to carry. A key English does not declare has nothing to compare.
    const english = languages.find((entry) => isEnglish(entry.language));
    if (!english || english.language === language) return errors;
    for (const declaration of keyDeclarationsOf(document)) {
        if (cancellationToken.isCancellationRequested) return errors;
        if (declaration.text === undefined || !isValueNode(declaration.node)) continue;
        const source = english.texts.get(declaration.path);
        if (source === undefined) continue;
        const expected = placeholdersOf(source);
        if (expected.length === 0) continue;
        const written = placeholdersOf(declaration.text);
        if (expected.length === written.length && expected.every((slot, index) => slot === written[index])) continue;
        errors.push({
            message: l10n.t(
                'This translation fills {0} instead of {1}, which the English text uses. The game fills the slots by name, so one it cannot find stays on screen as written.',
                written.length ? written.join(', ') : l10n.t('nothing'),
                expected.join(', ')
            ),
            node: declaration.node,
            severity: 'warning',
        });
    }
    return errors;
};
