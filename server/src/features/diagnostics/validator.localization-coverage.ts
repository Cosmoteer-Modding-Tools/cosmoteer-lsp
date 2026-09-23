import * as l10n from '@vscode/l10n';
import { CancellationToken } from 'vscode-languageserver';
import { AbstractNode, AbstractNodeDocument, isAssignmentNode, isValueNode } from '../../core/ast/ast';
import {
    declaresLanguage,
    englishOf,
    isStringsDocument,
    keyDeclarationsOf,
    LANGUAGE_ID,
    languageIdOf,
    languageOf,
    LocalizationKeyIndex,
} from '../completion/localization-key.index';
import { findModRoot } from '../../mod/mod-root';
import { uriToFsPath } from '../../workspace/workspace-files';
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
 * An assignment is never returned as itself. It is the one node the parser gives no span of its
 * own, so a finding anchored on one has nothing to underline, and the written name stands in for
 * it. A strings file that declares no `__Name` opens with an ordinary key, which is exactly that
 * case.
 *
 * @param document the strings file.
 * @returns the node to underline, or undefined for an empty file.
 */
const fileAnchor = (document: AbstractNodeDocument): AbstractNode | undefined => {
    for (const element of document.elements) {
        if (isAssignmentNode(element) && element.left.name === '__Name') return element.left;
    }
    const first = document.elements[0];
    return first && isAssignmentNode(first) ? first.left : first;
};

/**
 * Reports what one language of a mod is missing against the languages beside it: keys the other
 * strings files in the same folder declare and this one does not, and a key whose translation drops
 * or invents one of the placeholder slots the English text carries. Reports a whole language the
 * game will never offer as well, which is the file's own header missing.
 *
 * A key the language in play is missing is answered from English, which the game keeps loaded
 * behind it, so a player reading that language gets an English sentence. The raw key path is what
 * reaches the screen when English is missing the key as well, which is the English file's own case.
 * A placeholder slot the translation lost is worse still, since the number the sentence was about
 * never reaches the screen.
 *
 * Scoped to the mod being edited and to one folder, on purpose. The game's own strings are not
 * complete either, and a language of the base game is nothing a mod author can fix, so a file
 * outside a mod is never judged.
 *
 * Only the files the game loads as a language take part, and what the language already renders from
 * the base game's file of the same id counts as declared. A mod language sits on top of the one the
 * game ships, so the keys it leaves out are answered from there and are not missing at all.
 *
 * @param document the parsed strings file to validate.
 * @param folderPaths the project folders the strings index is built from.
 * @param cancellationToken cancellation for the index build.
 * @returns one warning when the game offers this language to nobody, one hint for the keys the
 *          language is missing, and one warning per mismatched placeholder set.
 */
export const validateLocalizationCoverage = async (
    document: AbstractNodeDocument,
    folderPaths: string[],
    cancellationToken: CancellationToken
): Promise<ValidationError[]> => {
    if (!isStringsDocument(document) || !findModRoot(document.uri)) return [];
    const language = languageOf(document);
    const id = languageIdOf(document);
    if (!language || !id) return [];

    const errors: ValidationError[] = [];
    const folder = folderOf(document.uri);
    const anchor = fileAnchor(document);
    const declaredIds = await LocalizationKeyIndex.instance.declaredLanguages(folderPaths, cancellationToken);
    if (cancellationToken.isCancellationRequested) return errors;
    // The picker lists a language only where some strings file opens with `__Name` on its first
    // line and `__DebugOnly` on its second, and it takes the id from the file name. A file named
    // after an id no file declares that way introduces a language the player cannot pick. An id
    // another file does declare, the game's own `en` above all, is overridden rather than
    // introduced and needs no header of its own. Without English in the index there is no game
    // tree to judge against, so nothing is said.
    if (
        anchor &&
        declaredIds.has('en') &&
        !declaredIds.has(id) &&
        LANGUAGE_ID.test(id) &&
        !declaresLanguage(document)
    ) {
        errors.push({
            message: l10n.t('The game offers no language "{0}", so a player cannot pick this one.', id),
            node: anchor,
            severity: 'warning',
            additionalInfo: l10n.t(
                'A file that introduces a language has to open with __Name on its first line and __DebugOnly on its second, ahead of any comment.'
            ),
        });
    }

    const languages = await LocalizationKeyIndex.instance.languageTextsUnder(folder, folderPaths, cancellationToken);
    if (cancellationToken.isCancellationRequested || languages.length < 2) return errors;

    // A file the game never loads as a language is absent from that list, so it is neither judged
    // nor held against the languages beside it.
    const own = languages.find((entry) => entry.id === id);
    const others = languages.filter((entry) => entry.id !== id);
    if (!own) return errors;
    const inherited = await LocalizationKeyIndex.instance.inheritedTextsFor(id, folder, folderPaths, cancellationToken);
    if (cancellationToken.isCancellationRequested) return errors;

    const declared = new Set<string>();
    for (const key of own.texts.keys()) declared.add(key.toLowerCase());
    for (const key of inherited.keys()) declared.add(key.toLowerCase());
    const missing: string[] = [];
    for (const other of others) {
        for (const key of other.texts.keys()) {
            if (declared.has(key.toLowerCase())) continue;
            declared.add(key.toLowerCase());
            missing.push(key);
        }
    }
    // The English text is the one the translations were written from, so it is what decides which
    // slots a sentence is supposed to carry. A key English does not declare has nothing to compare.
    const english = englishOf(languages);
    if (missing.length > 0 && anchor) {
        const listed = missing.slice(0, LISTED_KEYS).join(', ');
        // English is what every other language falls back to, so what a missing key costs depends on
        // which file is short of it: a translation renders the English sentence, English itself has
        // nothing behind it and renders the key path.
        const translated = english !== undefined && english.id !== id;
        errors.push({
            message: translated
                ? l10n.t(
                      '{0} declares {1} key(s) fewer than the languages beside it. A player reading it gets the English text for those, or the key path where English lacks them too.',
                      language,
                      missing.length
                  )
                : l10n.t(
                      '{0} declares {1} key(s) fewer than the languages beside it. Nothing falls back for those, so a player sees the key path instead of a sentence.',
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

    if (!english || english.id === id) return errors;
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
