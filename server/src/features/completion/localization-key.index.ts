import { CancellationToken, CompletionItemKind } from 'vscode-languageserver';
import {
    AbstractNode,
    AbstractNodeDocument,
    IdentifierNode,
    isAssignmentNode,
    isGroupNode,
    isListNode,
    isValueNode,
} from '../../core/ast/ast';
import { namedMembersOf } from '../../utils/ast.utils';
import { isLocalizationKeyType } from '../../document/schema/schema';
import { buildMatchPool, MatchPool } from '../../utils/did-you-mean';
import { normalizeUri } from '../navigation/reference-location';
import { WatchedDocumentIndex } from '../navigation/watched-document-index';
import { Completion } from './autocompletion.service';
import { fieldOfValueNode } from './autocompletion.schema';

/** A `strings/` (or `Strings/`) path segment, the reliable convention for language files. */
const STRINGS_PATH_SEGMENT = /(^|\/)strings\//;

/** One key's text in one language. */
export interface LocalizationText {
    /** The language label (`__Name`, e.g. `English`, or the file basename as a fallback). */
    language: string;
    /** The translated text for the key. */
    text: string;
}

/** The keys one strings file declares, tagged with its language. */
interface StringsFileKeys {
    language: string;
    /** key path (`Misc/Okay`) → its translated text. */
    keys: Map<string, string>;
}

/**
 * Whether `document` is a language strings file, whose leaf keys are localization keys. Two cheap
 * synchronous signals cover the field: a `strings/` path segment (the base game's `Data/strings` and
 * almost every mod) and a top-level `__Name` member (the required first line of a strings file, which
 * catches a mod placing them in a differently-named folder). Deliberately avoids the async
 * `StringsFolder` resolution `isStringsFile` does. This runs against every project file during the
 * one-time build, so it must not re-read manifests per file.
 */
export const isStringsDocument = (document: AbstractNodeDocument): boolean =>
    STRINGS_PATH_SEGMENT.test(normalizeUri(document.uri)) ||
    namedMembersOf(document).some(([name]) => name === '__Name');

/** The language label of a strings file: its `__Name` value, else its basename without extension. */
const languageOf = (document: AbstractNodeDocument): string => {
    for (const [name, value] of namedMembersOf(document)) {
        if (name === '__Name' && isValueNode(value)) return String(value.valueType.value);
    }
    return normalizeUri(document.uri).split('/').pop()?.replace(/\.rules$/i, '') ?? '';
};

/** One path a strings file declares, at the node that spells the path's last segment. */
export interface LocalizationKeyDeclaration {
    /** The path the game looks a string up by (`Misc/Okay`). */
    path: string;
    /** The identifier spelling the last segment, absent when that segment is a list position. */
    nameNode?: IdentifierNode;
    /** The list position the last segment stands for, absent for a named member. */
    listIndex?: number;
    /** The declared node, a leaf value or the group/list that holds the keys below this path. */
    node: AbstractNode;
    /** The translated text, present only for a leaf. A group holds further keys instead. */
    text?: string;
}

/**
 * Every path a strings container declares, in document order. A key is the slash-joined path from the
 * file root to a leaf value (`Misc` group → `Okay` leaf → `Misc/Okay`). Groups and lists are yielded
 * alongside the leaves, because a group's name is a segment every key beneath it carries, which is
 * what lets a rename move a whole branch. Meta members (`__Name`, `__DebugOnly`) are engine
 * directives, not keys.
 */
function* declarationsIn(
    container: { elements: AbstractNode[] },
    prefix: string
): Generator<LocalizationKeyDeclaration> {
    for (const element of container.elements) {
        let name: string | undefined;
        let nameNode: IdentifierNode | undefined;
        let member: AbstractNode | null | undefined;
        if (isAssignmentNode(element)) {
            name = element.left.name;
            nameNode = element.left;
            member = element.right;
        } else if ((isGroupNode(element) || isListNode(element)) && element.identifier) {
            name = element.identifier.name;
            nameNode = element.identifier;
            member = element;
        }
        if (!name || !nameNode || !member || name.startsWith('__')) continue;
        const path = prefix ? `${prefix}/${name}` : name;
        if (isGroupNode(member)) {
            yield { path, nameNode, node: member };
            yield* declarationsIn(member, path);
        } else if (isListNode(member)) {
            yield { path, nameNode, node: member };
            yield* listDeclarationsIn(member, path);
        } else if (isValueNode(member)) {
            yield { path, nameNode, node: member, text: String(member.valueType.value) };
        }
    }
}

/**
 * The paths of a strings list, addressed by element index: vanilla's `FameTitles [ "WHO??" … ]` is
 * referenced as `FameTitles/0`, `FameTitles/1`, … by `career.rules`. Such a segment is a position
 * rather than a name, which is why the declaration carries an index and no identifier.
 */
function* listDeclarationsIn(
    list: { elements: AbstractNode[] },
    prefix: string
): Generator<LocalizationKeyDeclaration> {
    for (let index = 0; index < list.elements.length; index++) {
        const element = list.elements[index];
        const path = `${prefix}/${index}`;
        if (isGroupNode(element)) {
            yield { path, listIndex: index, node: element };
            yield* declarationsIn(element, path);
        } else if (isListNode(element)) {
            yield { path, listIndex: index, node: element };
            yield* listDeclarationsIn(element, path);
        } else if (isValueNode(element)) {
            yield { path, listIndex: index, node: element, text: String(element.valueType.value) };
        }
    }
}

/**
 * Every localization key path `document` declares, leaves and the groups above them alike. One rule
 * decides what a path is, so the index and the rename can never disagree about which key a line of a
 * strings file declares.
 *
 * @param document the parsed strings file to read.
 * @returns each declared path with the node spelling its last segment.
 */
export function keyDeclarationsOf(document: AbstractNodeDocument): Generator<LocalizationKeyDeclaration> {
    return declarationsIn(document, '');
}

/** English-ish languages sort first in hover output so the most-read text leads. */
const isEnglish = (language: string): boolean => /^en\b|english/i.test(language);

/**
 * Project-wide index of localization keys, the data behind strings-key completion, existence
 * validation, and hover (a `KeyString` field such as `NameKey = "…"`). Built once over
 * {@link WatchedDocumentIndex.buildFromProject} (only the strings files among the walked documents
 * contribute) and kept current by the file watcher, so features never re-read the strings tree per
 * keystroke. All languages share one key tree, so key paths are de-duplicated across the per-language
 * files (`en.rules`, `de.rules`, …); each key's per-language texts are kept for hover.
 */
export class LocalizationKeyIndex extends WatchedDocumentIndex {
    private static _instance: LocalizationKeyIndex;

    /** normalized source uri → the language + key texts that strings file declares. */
    private readonly bySource = new Map<string, StringsFileKeys>();

    private constructor() {
        super();
    }

    public static get instance(): LocalizationKeyIndex {
        if (!LocalizationKeyIndex._instance) LocalizationKeyIndex._instance = new LocalizationKeyIndex();
        return LocalizationKeyIndex._instance;
    }

    /** This index's slot in the persistent game-tree cache. */
    public readonly cacheId = 'localizationKeys';

    protected clear(): void {
        this.bySource.clear();
    }

    /**
     * Serializes the per-source language and key texts for the persistent game-tree cache.
     *
     * @returns the JSON-safe state.
     */
    public saveState(): unknown {
        return [...this.bySource.entries()].map(([source, file]) => [source, file.language, [...file.keys.entries()]]);
    }

    /**
     * Primes the index from a previously saved state.
     *
     * @param state the value a prior {@link saveState} returned.
     * @returns true when the state had the expected shape and was loaded.
     */
    public loadState(state: unknown): boolean {
        if (!Array.isArray(state)) return false;
        this.clear();
        for (const entry of state as Array<[string, string, Array<[string, string]>]>) {
            if (
                !Array.isArray(entry) ||
                typeof entry[0] !== 'string' ||
                typeof entry[1] !== 'string' ||
                !Array.isArray(entry[2])
            ) {
                return false;
            }
            this.bySource.set(entry[0], { language: entry[1], keys: new Map(entry[2]) });
        }
        return true;
    }

    protected removeSource(source: string): void {
        this.bySource.delete(source);
    }

    protected indexDocument(document: AbstractNodeDocument): boolean {
        const source = normalizeUri(document.uri);
        const prior = this.bySource.get(source);
        this.bySource.delete(source);
        if (!isStringsDocument(document)) return prior !== undefined;
        const keys = new Map<string, string>();
        for (const declaration of keyDeclarationsOf(document)) {
            if (declaration.text !== undefined) keys.set(declaration.path, declaration.text);
        }
        const language = languageOf(document);
        if (keys.size) this.bySource.set(source, { language, keys });
        if (!prior) return keys.size > 0;
        if (prior.language !== language || prior.keys.size !== keys.size) return true;
        for (const [key, text] of keys) {
            if (prior.keys.get(key) !== text) return true;
        }
        return false;
    }

    private async ensureBuilt(folderPaths: string[], cancellationToken: CancellationToken): Promise<void> {
        await this.ensureFresh(
            (progress) => this.buildFromProject(folderPaths, progress),
            cancellationToken,
            'Indexing strings'
        );
    }

    /**
     * Completions for a value node that is a localization-key field, else `[]`. Gated internally (like
     * the cross-file id index) so an unrelated value stays cheap. The strings index only builds when
     * the cursor is actually on a `KeyString` field.
     */
    public async keyCompletionsForNode(
        node: AbstractNode,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Completion[]> {
        const field = await fieldOfValueNode(node, cancellationToken).catch(() => undefined);
        if (!isLocalizationKeyType(field?.valueType)) return [];
        return this.allKeyCompletions(folderPaths, cancellationToken);
    }

    /** Every localization key declared across the project's strings files, as completions. */
    public async allKeyCompletions(
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<Completion[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);

        const seen = new Set<string>();
        const out: Completion[] = [];
        for (const { keys } of this.bySource.values()) {
            for (const [key, text] of keys) {
                if (seen.has(key)) continue;
                seen.add(key);
                // The translated text as `detail` lets the completion list read as key → meaning.
                out.push({ label: key, kind: CompletionItemKind.Text, detail: text || 'localization key' });
            }
        }
        return out;
    }

    /** The merged key set (original and lowercased casing, plus the index-aligned suggestion pool),
     *  memoized against the index revision. The whole-workspace scan asks for all keys once per
     *  validated file, and re-merging (and re-lowercasing) tens of thousands of keys per file
     *  dominated the localization pass. */
    private allKeysMemo?: { revision: number; keys: Set<string>; keysLower: Set<string>; pool: MatchPool };

    /**
     * The merged key sets behind {@link allKeys}/{@link allKeysLower}/{@link allKeysMatchPool},
     * rebuilt only when the index content changed since the last call. Callers must not mutate
     * the returned sets.
     *
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns the shared key set, its lowercased counterpart, and the suggestion pool.
     */
    private async mergedKeys(
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<{ keys: Set<string>; keysLower: Set<string>; pool: MatchPool }> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        if (this.allKeysMemo && this.allKeysMemo.revision === this.revision) return this.allKeysMemo;
        const keys = new Set<string>();
        const keysLower = new Set<string>();
        for (const { keys: fileKeys } of this.bySource.values()) {
            for (const key of fileKeys.keys()) {
                keys.add(key);
                keysLower.add(key.toLowerCase());
            }
        }
        this.allKeysMemo = { revision: this.revision, keys, keysLower, pool: buildMatchPool(keys) };
        return this.allKeysMemo;
    }

    /** The set of every localization key declared in the project, for existence validation. The
     *  returned set is shared and must not be mutated. */
    public async allKeys(folderPaths: string[], cancellationToken: CancellationToken): Promise<Set<string>> {
        return (await this.mergedKeys(folderPaths, cancellationToken)).keys;
    }

    /** The lowercased counterpart of {@link allKeys}, for the game's case-insensitive key lookup.
     *  The returned set is shared and must not be mutated. */
    public async allKeysLower(folderPaths: string[], cancellationToken: CancellationToken): Promise<Set<string>> {
        return (await this.mergedKeys(folderPaths, cancellationToken)).keysLower;
    }

    /** The prepared did-you-mean pool over {@link allKeys}, in the same iteration order, so
     *  suggestion queries skip re-lowercasing the whole key set per broken key. */
    public async allKeysMatchPool(folderPaths: string[], cancellationToken: CancellationToken): Promise<MatchPool> {
        return (await this.mergedKeys(folderPaths, cancellationToken)).pool;
    }

    /**
     * The strings files that declare `path`, as normalized source uris. With `prefix` the answer
     * covers every key the path stands above, which is what a group rename moves. Matching folds
     * case, because the game keys a node's children with an invariant case-insensitive comparer and
     * vanilla itself relies on that (`doodad_asteroid_gold_s.rules` asks for `Doodads/Asteroidgold_S`
     * while the strings file spells it `AsteroidGold_S`).
     *
     * The rename uses this to see whether anything outside the mod being edited already declares the
     * key. The base game and another mod's strings cannot be written, so a key they also declare
     * cannot be renamed from here without leaving the two spellings out of step.
     *
     * @param path the key path, or the group path when `prefix` is set.
     * @param prefix whether every key beneath `path` counts, not just `path` itself.
     * @param folderPaths the project folders the strings index is built from.
     * @param cancellationToken cancellation for the index build.
     * @returns the normalized uris of the declaring strings files, in index order.
     */
    public async sourcesDeclaring(
        path: string,
        prefix: boolean,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<string[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const wanted = path.toLowerCase();
        const branch = `${wanted}/`;
        const sources: string[] = [];
        for (const [source, file] of this.bySource) {
            for (const key of file.keys.keys()) {
                const folded = key.toLowerCase();
                if (folded !== wanted && !(prefix && folded.startsWith(branch))) continue;
                sources.push(source);
                break;
            }
        }
        return sources;
    }

    /**
     * The text of `key` in each language that declares it, one line per language, English first, for
     * hover. Empty when the key is undeclared. A language can declare a key in several strings files
     * (the base game splits English across files, and a mod can redeclare a vanilla key). The game
     * loads the game `Data` tree before the mod, so a later declaration overrides an earlier one.
     * {@link bySource} iterates in that same order, so keeping the last value seen per language makes
     * hover show the string the game actually renders, not the shadowed vanilla one.
     */
    public async textsForKey(
        key: string,
        folderPaths: string[],
        cancellationToken: CancellationToken
    ): Promise<LocalizationText[]> {
        await this.ensureBuilt(folderPaths, cancellationToken);
        const byLanguage = new Map<string, string>();
        for (const { language, keys } of this.bySource.values()) {
            const text = keys.get(key);
            if (text !== undefined) byLanguage.set(language, text);
        }
        const texts = [...byLanguage].map(([language, text]) => ({ language, text }));
        texts.sort((a, b) => Number(isEnglish(b.language)) - Number(isEnglish(a.language)));
        return texts;
    }
}
