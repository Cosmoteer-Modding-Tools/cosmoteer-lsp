import { readFile } from 'fs/promises';
import { CancellationToken, TextEdit } from 'vscode-languageserver';
import { AbstractNodeDocument, GroupNode, isValueNode, ValueNode } from '../../../core/ast/ast';
import { isLocalizationKeyType, localizationKeyFieldNames } from '../../../document/schema/schema';
import { namedMembersOf, parseText } from '../../../utils/ast.utils';
import { fieldOfValueNode } from '../../completion/autocompletion.schema';
import { LocalizationText } from '../../completion/localization-key.index';
import { insertEditsForFile, LocalizationKeyInsertion } from '../../diagnostics/localization-key-insert';

/**
 * A key path as a strings file declares one: slash-joined member names, nothing a name cannot hold.
 * Spelled out here rather than shared with the extraction refactoring, which keeps its own copy
 * private, because the two features are free to disagree about what they will accept.
 */
const KEY_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/** `deposit_carbon_1x` to `DepositCarbon1x`, the spelling strings files name an entity with. */
const pascalCase = (raw: string): string =>
    raw
        .split(/[^A-Za-z0-9]+/)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');

/** One localization key the source writes, and the field writing it. */
interface CloneKeyField {
    /** The field's name as the file spells it. */
    readonly field: string;
    /** The key path the source points at. */
    readonly sourceKey: string;
    /** The value node the copy repoints. */
    readonly node: ValueNode;
}

/** One localization key the copy declares in place of the source's. */
export interface CloneKey extends CloneKeyField {
    /** The key path the copy points at. */
    readonly newKey: string;
}

/** One strings file of the destination mod, with the edits that declare the copy's keys in it. */
export interface StringsFileInsert {
    /** The strings file's on-disk path. */
    readonly fsPath: string;
    /** The file's current source, which the edits are measured against. */
    readonly text: string;
    /** The insertions, ascending and non-overlapping. */
    readonly edits: TextEdit[];
}

/**
 * The localization keys the cloned container writes itself.
 *
 * Only the container's own members are read, never the whole file: a directory copy carries files
 * that write their own keys for their own entities, and repointing those would rename strings that
 * have nothing to do with the copy.
 *
 * The field name is a cheap pre-filter and the schema then decides. A member called `NameKey` on a
 * class that types it as something else is not a localization key however it is spelled, so it is
 * dropped. A member whose class the schema cannot work out at all is kept on the name alone: a mod's
 * collection fragment is only typed once an action or an alias roots it, and none of the refactoring
 * commands waits for that build, so refusing there would quietly leave every fragment's keys behind.
 * The names come from the schema itself, so a name in that set is a localization key wherever it is
 * written.
 *
 * @param container the group or document being cloned.
 * @param cancellationToken cancels the schema resolution.
 * @returns the key fields in document order, empty when the container points at no key.
 */
export const localizationKeyFieldsOf = async (
    container: GroupNode | AbstractNodeDocument,
    cancellationToken: CancellationToken
): Promise<CloneKeyField[]> => {
    const names = localizationKeyFieldNames();
    const found: CloneKeyField[] = [];
    for (const [name, member] of namedMembersOf(container)) {
        if (!names.has(name.toLowerCase()) || !isValueNode(member)) continue;
        const key = String(member.valueType.value).trim();
        if (!KEY_PATH.test(key)) continue;
        const field = await fieldOfValueNode(member, cancellationToken).catch(() => undefined);
        if (field && !isLocalizationKeyType(field.valueType)) continue;
        found.push({ field: name, sourceKey: key, node: member });
    }
    return found;
};

/** The entity name of an id, which is the part of it a key is ever named after. */
const leafOf = (id: string): string => id.slice(id.lastIndexOf('.') + 1) || id;

/**
 * Where a key path names an entity, and in which of the two spellings.
 *
 * A name only counts when it stands as a name: it has to start the key or follow a `/`, and it has to
 * end at a `/`, at a separator, at the start of the next word or at the end of the key. Without that
 * boundary a two-letter id such as `io` would claim `Parts/Ion` and the copy would take a key that has
 * nothing to do with it.
 *
 * @param key the key path to look in.
 * @param name the entity name to look for, in the spelling being tried.
 * @returns the offset the name starts at, or -1 when the key does not name that entity.
 */
const nameAt = (key: string, name: string): number => {
    if (name === '') return -1;
    const lowerKey = key.toLowerCase();
    const lowerName = name.toLowerCase();
    for (let at = lowerKey.indexOf(lowerName); at !== -1; at = lowerKey.indexOf(lowerName, at + 1)) {
        if (at !== 0 && key[at - 1] !== '/') continue;
        const after = key[at + name.length];
        if (after === undefined || after === '/' || after === '_' || after === '-' || after === '.') return at;
        if (after >= 'A' && after <= 'Z') return at;
        if (after >= '0' && after <= '9') return at;
    }
    return -1;
};

/**
 * The key path the copy points at: the source's own key with the entity's name in it swapped for the
 * copy's, so `Parts/CannonMed` becomes `Parts/CannonBig`, `Parts/CannonMedDesc` becomes
 * `Parts/CannonBigDesc` and `Lore/Cabal/Title` becomes `Lore/Trader/Title`.
 *
 * A key that does not name the entity at all is left pointing where it points. Such a key is a shared
 * vocabulary rather than this entity's own text, the way every codex page writes the same
 * `TabNameKey`, and giving the copy a fresh key for it would only leave the copy with an empty string
 * where the game shows the tab's name. Five of the game's own name keys are shared by two files each,
 * so a key is never assumed to belong to one declaration, and nothing at the source is renamed or
 * removed by a clone either way.
 *
 * A key that is taken gets a counting suffix.
 *
 * @param sourceKey the key the source points at.
 * @param sourceId the id the source declares, whose entity name the key is searched for.
 * @param newId the id the copy declares.
 * @param taken every key path the project already declares, lower-cased.
 * @returns the derived key path, or undefined when the key names some other thing entirely.
 */
export const deriveCloneKey = (
    sourceKey: string,
    sourceId: string,
    newId: string,
    taken: ReadonlySet<string>
): string | undefined => {
    const source = leafOf(sourceId);
    const target = leafOf(newId);
    // The strings files spell an entity in PascalCase, the ids spell it with underscores, and a key
    // may be written either way, so both are tried and the copy answers in the same spelling.
    const spellings: Array<[string, string]> = [
        [pascalCase(source), pascalCase(target)],
        [source, target],
    ];
    for (const [from, to] of spellings) {
        const at = nameAt(sourceKey, from);
        if (at === -1) continue;
        const base = `${sourceKey.slice(0, at)}${to}${sourceKey.slice(at + from.length)}`;
        let key = base;
        for (let index = 2; taken.has(key.toLowerCase()); index++) key = `${base}${index}`;
        return key;
    }
    return undefined;
};

/**
 * The text a given language file gets for a key.
 *
 * The destination file's own name is matched against the label the index carries for each source
 * text, which is that source file's `__Name` when it declares one and its bare file name otherwise.
 * Anything unmatched gets the English text, which is what the index sorts first. Matching a language
 * by its label alone would be wrong on most of the corpus: 36 of the 58 strings files of the installed
 * workshop mods declare no `__Name` at all, and the labels that do exist disagree with each other
 * (`Spanish` next to `Russian` next to `Русский`), while the game's own files are named `en.rules` and
 * `de.rules` but labelled `English` and `Deutsch`. Writing the English text is the same policy the
 * key extraction already follows: nothing the player sees changes until somebody translates it.
 *
 * @param fsPath the destination strings file.
 * @param texts the source key's text in each language the project has.
 * @returns the value text to write, quotes included.
 */
export const textForStringsFile = (fsPath: string, texts: readonly LocalizationText[]): string => {
    const name = fsPath.replace(/\\/g, '/').split('/').pop() ?? '';
    const stem = name.replace(/\.[^.]*$/, '').toLowerCase();
    const matched = texts.find((entry) => entry.language.toLowerCase() === stem);
    const text = (matched ?? texts[0])?.text;
    // A key nothing declares anywhere leaves a placeholder to fill in rather than an invented string.
    return text === undefined ? '""' : `"${text}"`;
};

/**
 * The edits that declare every one of the copy's keys in every language file of the destination mod.
 *
 * Each file is read and parsed exactly once for the whole batch, which is what keeps this affordable
 * inside an interactive command: the game's own strings tree is 3.2 MB over eight files, so a part
 * carrying three keys would otherwise cost 24 parses of large files.
 *
 * @param stringsFiles the destination mod's language files, as on-disk paths.
 * @param keys the keys to declare, with the texts they carry in each language.
 * @param readOverride the unsaved text of an open file, so an edit is measured against the buffer the
 * client will apply it to rather than against stale bytes on disk.
 * @returns one entry per file that gains something, empty when every file already declares every key.
 */
export const stringsInsertsFor = async (
    stringsFiles: readonly string[],
    keys: ReadonlyArray<{ newKey: string; texts: readonly LocalizationText[] }>,
    readOverride?: (fsPath: string) => string | undefined
): Promise<StringsFileInsert[]> => {
    if (keys.length === 0) return [];
    const inserts: StringsFileInsert[] = [];
    for (const fsPath of stringsFiles) {
        const text = readOverride?.(fsPath) ?? (await readFile(fsPath, { encoding: 'utf-8' }).catch(() => undefined));
        if (text === undefined) continue;
        let document: AbstractNodeDocument;
        try {
            document = parseText(text, fsPath);
        } catch {
            // A language file this editor cannot read is left exactly as it is.
            continue;
        }
        const insertions: LocalizationKeyInsertion[] = keys.map((key) => ({
            key: key.newKey,
            value: textForStringsFile(fsPath, key.texts),
        }));
        const edits = insertEditsForFile(document, text, insertions);
        if (edits.length > 0) inserts.push({ fsPath, text, edits });
    }
    return inserts;
};
